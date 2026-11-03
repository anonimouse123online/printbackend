import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomBytes, createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { app } from '../src/app.js';
import { prisma } from '../src/db.js';
import { config } from '../src/config.js';
import { hashPassword, issueToken } from '../src/auth.js';
import { deleteFile, deletePrivateImage } from '../src/storage.js';

const dbUrl = new URL(config.DATABASE_URL);
if (config.NODE_ENV !== 'development' || !['localhost', '127.0.0.1', '::1'].includes(dbUrl.hostname) || dbUrl.pathname !== '/printready_test') {
  throw new Error('Integration tests are restricted to the isolated local printready_test database.');
}

const suffix = randomBytes(8).toString('hex');
const ids = { users: [], shops: [], orders: [], files: [] };
const auth = token => ({ Authorization: `Bearer ${token}` });

afterAll(async () => {
  for (const file of await prisma.documentFile.findMany({ where: { id: { in: ids.files } }, select: { storageKey: true } })) await deleteFile(file.storageKey);
  const privateKeys=[];
  if(ids.shops.length)for(const shop of await prisma.printingShop.findMany({where:{id:{in:ids.shops}},select:{paymentQrStorageKey:true}}))if(shop.paymentQrStorageKey)privateKeys.push(shop.paymentQrStorageKey);
  if(ids.orders.length)for(const payment of await prisma.payment.findMany({where:{orderId:{in:ids.orders}},select:{proofStorageKey:true,recipientQrStorageKey:true}}))privateKeys.push(payment.proofStorageKey,payment.recipientQrStorageKey);
  for(const key of new Set(privateKeys.filter(Boolean)))await deletePrivateImage(key);
  await prisma.$transaction(async tx => {
    if (ids.orders.length) {
      await tx.pickupDispute.deleteMany({ where: { orderId: { in: ids.orders } } });
      await tx.payment.deleteMany({ where: { orderId: { in: ids.orders } } });
      await tx.printOrder.deleteMany({ where: { id: { in: ids.orders } } });
    }
    if (ids.files.length) await tx.documentFile.deleteMany({ where: { id: { in: ids.files } } });
    if (ids.shops.length) {
      await tx.shopService.deleteMany({ where: { shopId: { in: ids.shops } } });
      await tx.shopOperatingHour.deleteMany({ where: { shopId: { in: ids.shops } } });
      await tx.printingShop.deleteMany({ where: { id: { in: ids.shops } } });
    }
    if (ids.users.length) {
      await tx.notification.deleteMany({ where: { userId: { in: ids.users } } });
      await tx.auditLog.deleteMany({ where: { actorId: { in: ids.users } } });
      await tx.user.deleteMany({ where: { id: { in: ids.users } } });
    }
  });
  await prisma.$disconnect();
});

describe('PrintReady API integration', () => {
  it('registers users, manages a shop, uploads a PDF, scopes orders, and confirms pickup manually', async () => {
    const advisoryLock = await prisma.$transaction(tx => tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext('printready-initial-admin')) AS locked`);
    expect(advisoryLock).toEqual([{ locked: true }]);

    const ready = await request(app).get('/api/v1/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.data.database).toBe('connected');

    const register = async (route, label) => {
      const response = await request(app).post(`/api/v1/auth/register${route}`).send({
        fullName: `Test ${label}`,
        email: `${label}-${suffix}@example.test`,
        password: `PrintReady-${suffix}-Strong!`,
        role: 'ADMIN',
      });
      expect(response.status).toBe(201);
      ids.users.push(response.body.data.user.id);
      return response.body.data;
    };

    const customer = await register('', 'customer');
    expect(customer.user.role).toBe('CUSTOMER');
    const customerLogin = await request(app).post('/api/v1/auth/login').send({ email: `customer-${suffix}@example.test`, password: `PrintReady-${suffix}-Strong!` });
    expect(customerLogin.status).toBe(200);
    const otherCustomer = await register('', 'other-customer');
    const owner = await register('/shop-owner', 'owner');
    expect(owner.user.role).toBe('SHOP_OWNER');
    const otherOwner = await register('/shop-owner', 'other-owner');

    const shopResponse = await request(app).post('/api/v1/shops').set(auth(owner.token)).send({ shopName: `Test Print Shop ${suffix}`, address: '123 Test Street', city: 'Manila' });
    expect(shopResponse.status).toBe(201);
    const shop = shopResponse.body.data.shop;
    ids.shops.push(shop.id);
    expect(shop.verificationStatus).toBe('PENDING');

    const unauthorizedUpdate = await request(app).patch(`/api/v1/shops/${shop.id}`).set(auth(otherOwner.token)).send({ description: 'not allowed' });
    expect(unauthorizedUpdate.status).toBe(403);

    expect((await request(app).get('/api/v1/admin/shops/pending').set(auth(customer.token))).status).toBe(403);
    expect((await request(app).patch(`/api/v1/admin/shops/${shop.id}/verification`).set(auth(owner.token)).send({ status: 'VERIFIED' })).status).toBe(403);
    expect((await request(app).get(`/api/v1/shops/${shop.id}`)).status).toBe(404);

    const admin = await prisma.user.create({ data: { fullName: `Test Admin ${suffix}`, email: `admin-${suffix}@example.test`, passwordHash: await hashPassword(`PrintReady-${suffix}-Admin!`), role: 'ADMIN' } });
    ids.users.push(admin.id);
    const adminToken = issueToken(admin);
    const pending = await request(app).get('/api/v1/admin/shops/pending').set(auth(adminToken));
    expect(pending.status).toBe(200);
    expect(pending.body.data.shops.find(item => item.id === shop.id)?.owner?.email).toBe(`owner-${suffix}@example.test`);
    const detail = await request(app).get(`/api/v1/admin/shops/${shop.id}`).set(auth(adminToken));
    expect(detail.status).toBe(200);
    expect(detail.body.data.shop.address).toBe('123 Test Street');

    const servicesResponse = await request(app).put(`/api/v1/shops/${shop.id}/services`).set(auth(owner.token)).send({ services: [{
      serviceName: 'Document printing', serviceType: 'DOCUMENT', isAvailable: true,
      pricingConfiguration: { rates: { 'A4:BW:SINGLE': 250 }, bindingCents: { comb: 1000 } },
    }] });
    expect(servicesResponse.status).toBe(200);
    const service = servicesResponse.body.data.services[0];

    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([200, 200]);
    const pdf = Buffer.from(await pdfDoc.save());
    const upload = await request(app).post('/api/v1/files').set(auth(customer.token)).attach('file', pdf, { filename: 'test-document.pdf', contentType: 'application/pdf' });
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const file = upload.body.data.file;
    ids.files.push(file.id);
    const scanRecord = await prisma.documentFile.findUnique({ where: { id: file.id }, select: { scanStatus: true, scannedAt: true } });
    expect(scanRecord.scanStatus).toBe('AVAILABLE');
    expect(scanRecord.scannedAt).toBeTruthy();

    const blockedOrder = await request(app).post('/api/v1/orders').set(auth(customer.token)).send({ shopId: shop.id, items: [{
      fileId: file.id, serviceId: service.id, paperSize: 'A4', colorMode: 'BW', printSides: 'SINGLE', copies: 2,
    }] });
    expect(blockedOrder.status).toBe(404);

    const reviewNote = 'Integration review approved';
    const verified = await request(app).patch(`/api/v1/admin/shops/${shop.id}/verification`).set(auth(adminToken)).send({ status: 'VERIFIED', notes: reviewNote });
    expect(verified.status).toBe(200);
    expect(verified.body.data.shop.verificationReviewerId).toBe(admin.id);
    expect(verified.body.data.shop.verificationReviewedAt).toBeTruthy();

    await prisma.documentFile.update({ where: { id: file.id }, data: { scanStatus: 'QUARANTINED', scannedAt: null } });
    const quarantinedOrder = await request(app).post('/api/v1/orders').set(auth(customer.token)).send({ shopId: shop.id, items: [{
      fileId: file.id, serviceId: service.id, paperSize: 'A4', colorMode: 'BW', printSides: 'SINGLE', copies: 2,
    }] });
    expect(quarantinedOrder.status).toBe(404);
    await prisma.documentFile.update({ where: { id: file.id }, data: { scanStatus: 'AVAILABLE', scannedAt: new Date() } });
    expect(verified.body.data.shop.verificationNotes).toBe(reviewNote);
    const ownerShops = await request(app).get('/api/v1/owner/shops').set(auth(owner.token));
    expect(ownerShops.body.data.shops.find(item => item.id === shop.id)?.verificationStatus).toBe('VERIFIED');
    expect((await request(app).get(`/api/v1/shops/${shop.id}`)).status).toBe(200);
    const discovery = await request(app).get('/api/v1/shops?city=Manila');
    expect(discovery.body.data.shops.some(item => item.id === shop.id)).toBe(true);
    const discoveryPage = await request(app).get('/api/v1/shops?city=Manila&limit=1');
    expect(discoveryPage.status).toBe(200);
    expect(discoveryPage.body.data.shops.length).toBeLessThanOrEqual(1);
    expect(discoveryPage.body.data.pagination).toMatchObject({limit:1,hasMore:expect.any(Boolean)});
    expect((await request(app).get('/api/v1/shops?cursor=not-a-valid-cursor')).body.error.code).toBe('INVALID_CURSOR');

    const tinyPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS4cAAAAASUVORK5CYII=','base64');
    const createOrder = await request(app).post('/api/v1/orders').set(auth(customer.token)).send({ shopId: shop.id, items: [{
      fileId: file.id, serviceId: service.id, paperSize: 'A4', colorMode: 'BW', printSides: 'SINGLE', copies: 2,
    }] });
    expect(createOrder.status).toBe(201);
    const order = createOrder.body.data.order;
    ids.orders.push(order.id);
    expect(order.totalCents).toBe(500);
    expect((await request(app).get(`/api/v1/orders/${order.id}`).set(auth(otherCustomer.token))).status).toBe(404);
    const customerOrder=await request(app).get(`/api/v1/orders/${order.id}`).set(auth(customer.token));
    expect(customerOrder.status).toBe(200);
    const ownerOrder=await request(app).get(`/api/v1/orders/${order.id}`).set(auth(owner.token));
    expect(ownerOrder.status).toBe(200);
    expect(ownerOrder.body.data.order.customer.email).toBe(`customer-${suffix}@example.test`);
    expect(ownerOrder.body.data.order.items[0]).toMatchObject({paperSize:'A4',colorMode:'BW',printSides:'SINGLE',copies:2});
    expect(ownerOrder.body.data.order.items[0].service.serviceName).toBe('Document printing');
    expect(ownerOrder.body.data.order.items[0].file.originalFilename).toBe('test-document.pdf');
    expect(ownerOrder.body.data.order.shop).not.toHaveProperty('ownerId');
    expect(ownerOrder.body.data.order.shop.paymentQrConfigured).toBe(false);
    expect((await request(app).get(`/api/v1/orders/${order.id}`).set(auth(otherOwner.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/orders/${order.id}/files/${file.id}`).set(auth(owner.token))).status).toBe(200);
    expect((await request(app).get(`/api/v1/orders/${order.id}/files/${file.id}`).set(auth(otherOwner.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/orders/${order.id}/files/${file.id}`).set(auth(otherCustomer.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/files/${file.id}`).set(auth(otherOwner.token))).status).toBe(404);
    expect((await request(app).patch(`/api/v1/orders/${order.id}/confirm`).set(auth(otherOwner.token)).send({})).status).toBe(404);
    expect((await request(app).patch(`/api/v1/orders/${order.id}/confirm`).set(auth(customer.token)).send({})).status).toBe(403);

    const unconfiguredConfirm=await request(app).patch(`/api/v1/orders/${order.id}/confirm`).set(auth(owner.token)).send({});
    expect(unconfiguredConfirm.status).toBe(409);
    expect(unconfiguredConfirm.body.error.code).toBe('PAYMENT_QR_NOT_CONFIGURED');
    expect((await prisma.printOrder.findUnique({where:{id:order.id}})).orderStatus).toBe('SUBMITTED');
    const qrUpload=await request(app).put(`/api/v1/shops/${shop.id}/payment-qr`).set(auth(owner.token)).field('paymentMethod','GCASH').field('recipientName','Sample Owner').field('walletNumber','09170000000').attach('qrImage',tinyPng,{filename:'shop-qr.png',contentType:'image/png'});
    expect(qrUpload.status).toBe(200);
    expect(qrUpload.body.data.paymentQr).toMatchObject({paymentMethod:'GCASH',recipientName:'Sample Owner',walletNumber:'09170000000',configured:true});
    const configuredOrder=await request(app).get(`/api/v1/orders/${order.id}`).set(auth(owner.token));
    expect(configuredOrder.body.data.order.shop.paymentQrConfigured).toBe(true);
    expect(configuredOrder.body.data.order.shop).not.toHaveProperty('paymentQrStorageKey');
    expect((await request(app).get(`/api/v1/shops/${shop.id}`)).body.data.shop).not.toHaveProperty('paymentQrStorageKey');
    expect((await request(app).get('/api/v1/owner/shops').set(auth(owner.token))).body.data.shops.find(s=>s.id===shop.id)).not.toHaveProperty('paymentQrStorageKey');
    expect((await request(app).put(`/api/v1/shops/${shop.id}/payment-qr`).set(auth(otherOwner.token)).field('paymentMethod','MAYA').field('recipientName','Other Shop').attach('qrImage',tinyPng,{filename:'other.png',contentType:'image/png'})).status).toBe(404);
    const changedPricing={...service.pricingConfiguration,rates:{...service.pricingConfiguration.rates,'A4:BW:SINGLE':251}};
    await prisma.shopService.update({where:{id:service.id},data:{pricingConfiguration:changedPricing}});
    const staleQuote=await request(app).patch(`/api/v1/orders/${order.id}/confirm`).set(auth(owner.token)).send({});
    expect(staleQuote.status).toBe(409);
    expect(staleQuote.body.error.code).toBe('ORDER_PRICE_CHANGED');
    expect((await prisma.printOrder.findUnique({where:{id:order.id}})).orderStatus).toBe('SUBMITTED');
    await prisma.shopService.update({where:{id:service.id},data:{pricingConfiguration:service.pricingConfiguration}});

    const confirm=await request(app).patch(`/api/v1/orders/${order.id}/confirm`).set(auth(owner.token)).send({});
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.payment).toMatchObject({amountCents:500,currency:'PHP'});
    expect((await request(app).patch(`/api/v1/orders/${order.id}/confirm`).set(auth(owner.token)).send({})).body.data.payment.id).toBe(confirm.body.data.payment.id);
    const instructions=await request(app).get(`/api/v1/orders/${order.id}/payment-instructions`).set(auth(customer.token));
    expect(instructions.status).toBe(200);
    expect(instructions.body.data).toMatchObject({payment:{amountCents:500,currency:'PHP'},recipient:{method:'GCASH',accountName:'Sample Owner',walletNumber:'09170000000'}});
    expect((await request(app).get(`/api/v1/orders/${order.id}/payment-instructions`).set(auth(otherCustomer.token))).status).toBe(404);
    const qrImage=await request(app).get(`/api/v1/orders/${order.id}/payment-qr`).set(auth(customer.token));
    expect(qrImage.status).toBe(200);
    expect(qrImage.headers['content-type']).toContain('image/png');
    expect((await request(app).patch(`/api/v1/orders/${order.id}/status`).set(auth(owner.token)).send({ status: 'PRINTING' })).status).toBe(409);
    expect((await request(app).post(`/api/v1/orders/${order.id}/payments/checkout`).set(auth(customer.token)).send({})).status).toBe(503);

    const submitProof=()=>request(app).post(`/api/v1/orders/${order.id}/payments/proof`).set(auth(customer.token)).field('referenceNumber',`REF-${suffix}`).field('note','Sent from wallet').attach('receipt',tinyPng,{filename:'receipt.png',contentType:'image/png'});
    const proof=await submitProof();
    expect(proof.status).toBe(201);
    expect(proof.body.data.payment.reviewStatus).toBe('PENDING_VERIFICATION');
    expect((await submitProof()).body.data.idempotent).toBe(true);
    expect((await request(app).get(`/api/v1/orders/${order.id}/payment-proof`).set(auth(owner.token))).status).toBe(200);
    expect((await request(app).get(`/api/v1/orders/${order.id}/payment-proof`).set(auth(otherOwner.token))).status).toBe(404);
    expect((await request(app).patch(`/api/v1/orders/${order.id}/payments/review`).set(auth(customer.token)).send({status:'APPROVED'})).status).toBe(403);
    expect((await request(app).patch(`/api/v1/orders/${order.id}/payments/review`).set(auth(otherOwner.token)).send({status:'APPROVED'})).status).toBe(404);
    const rejection=await request(app).patch(`/api/v1/orders/${order.id}/payments/review`).set(auth(owner.token)).send({status:'REJECTED',reason:'Reference did not match wallet history'});
    expect(rejection.status).toBe(200);
    expect(rejection.body.data.payment.reviewStatus).toBe('REJECTED');
    expect(rejection.body.data.payment.rejectionReason).toBe('Reference did not match wallet history');
    const resubmitted=await request(app).post(`/api/v1/orders/${order.id}/payments/proof`).set(auth(customer.token)).field('referenceNumber',`REF-RETRY-${suffix}`);
    expect(resubmitted.status).toBe(201);
    expect(resubmitted.body.data.payment.reviewStatus).toBe('PENDING_VERIFICATION');
    const approved=await request(app).patch(`/api/v1/orders/${order.id}/payments/review`).set(auth(owner.token)).send({status:'APPROVED'});
    expect(approved.status).toBe(200);
    expect(approved.body.data.payment.reviewStatus).toBe('APPROVED');
    expect((await prisma.printOrder.findUnique({where:{id:order.id}})).orderStatus).toBe('PAID');
    expect((await prisma.payment.findFirst({where:{orderId:order.id,provider:'manual_qr'}})).status).toBe('SUCCEEDED');
    expect((await request(app).get(`/api/v1/orders/${order.id}/payment-qr`).set(auth(customer.token))).status).toBe(409);
    const duplicateOrderResponse=await request(app).post('/api/v1/orders').set(auth(customer.token)).send({shopId:shop.id,items:[{fileId:file.id,serviceId:service.id,paperSize:'A4',colorMode:'BW',printSides:'SINGLE',copies:2},{fileId:file.id,serviceId:service.id,paperSize:'A4',colorMode:'BW',printSides:'SINGLE',copies:1}]});
    expect(duplicateOrderResponse.status).toBe(201);
    const duplicateOrder=duplicateOrderResponse.body.data.order;
    ids.orders.push(duplicateOrder.id);
    expect(duplicateOrder.items).toHaveLength(2);
    const firstOrderPage=await request(app).get('/api/v1/orders?limit=1').set(auth(customer.token));
    expect(firstOrderPage.status).toBe(200);
    expect(firstOrderPage.body.data.orders).toHaveLength(1);
    expect(firstOrderPage.body.data.pagination.hasMore).toBe(true);
    const secondOrderPage=await request(app).get(`/api/v1/orders?limit=1&cursor=${encodeURIComponent(firstOrderPage.body.data.pagination.nextCursor)}`).set(auth(customer.token));
    expect(secondOrderPage.status).toBe(200);
    expect(secondOrderPage.body.data.orders).toHaveLength(1);
    expect(secondOrderPage.body.data.orders[0].id).not.toBe(firstOrderPage.body.data.orders[0].id);
    expect((await request(app).patch(`/api/v1/orders/${duplicateOrder.id}/confirm`).set(auth(owner.token)).send({})).status).toBe(200);
    const duplicateReference=await request(app).post(`/api/v1/orders/${duplicateOrder.id}/payments/proof`).set(auth(customer.token)).send({referenceNumber:`REF-RETRY-${suffix}`});
    expect(duplicateReference.status).toBe(409);
    expect(duplicateReference.body.error.code).toBe('DUPLICATE_PAYMENT_REFERENCE');

    const ownerMessage=await request(app).post(`/api/v1/orders/${order.id}/messages`).set(auth(owner.token)).send({message:'We received your printing request.'});
    expect(ownerMessage.status).toBe(201);
    expect((await request(app).get('/api/v1/orders/messages/unread-count').set(auth(customer.token))).body.data.unreadCount).toBe(1);
    expect((await request(app).get(`/api/v1/orders/${order.id}/messages`).set(auth(otherCustomer.token))).status).toBe(404);
    expect((await request(app).get(`/api/v1/orders/${order.id}/messages`).set(auth(otherOwner.token))).status).toBe(404);
    const customerMessages=await request(app).get(`/api/v1/orders/${order.id}/messages?limit=10`).set(auth(customer.token));
    expect(customerMessages.status).toBe(200);
    expect(customerMessages.body.data.messages[0].body).toBe('We received your printing request.');
    expect(customerMessages.body.data.messages[0].readAt).toBeTruthy();
    expect((await request(app).get('/api/v1/orders/messages/unread-count').set(auth(customer.token))).body.data.unreadCount).toBe(0);
    expect((await request(app).post(`/api/v1/orders/${order.id}/messages`).set(auth(customer.token)).send({message:'Thank you.'})).status).toBe(201);
    expect((await request(app).get(`/api/v1/orders/${order.id}/messages?limit=1`).set(auth(owner.token))).body.data.messages).toHaveLength(1);
    const sharedMessageTime=new Date();
    const tiedMessageA=await prisma.orderMessage.create({data:{id:`cursor-a-${suffix}`,orderId:order.id,senderId:owner.user.id,recipientId:customer.user.id,body:'Same timestamp A',createdAt:sharedMessageTime}});
    const tiedMessageB=await prisma.orderMessage.create({data:{id:`cursor-b-${suffix}`,orderId:order.id,senderId:owner.user.id,recipientId:customer.user.id,body:'Same timestamp B',createdAt:sharedMessageTime}});
    const tiedMessagePage=await request(app).get(`/api/v1/orders/${order.id}/messages?limit=1&after=${encodeURIComponent(tiedMessageA.createdAt.toISOString())}&afterId=${tiedMessageA.id}`).set(auth(customer.token));
    expect(tiedMessagePage.status).toBe(200);
    expect(tiedMessagePage.body.data.messages.map(item=>item.id)).toContain(tiedMessageB.id);

    // Advance this isolated, manually approved test order to pickup state; preserve its historical token.
    const pickupValue = randomBytes(32).toString('base64url');
    await prisma.$transaction([
      prisma.printOrder.update({ where: { id: order.id }, data: { orderStatus: 'READY_FOR_PICKUP' } }),
      prisma.pickupToken.create({ data: { orderId: order.id, tokenHash: createHash('sha256').update(pickupValue).digest('hex'), expiresAt: new Date(Date.now() + 60_000) } }),
    ]);
    expect((await request(app).get(`/api/v1/files/${file.id}`).set(auth(owner.token))).status).toBe(200);
    expect((await request(app).post(`/api/v1/orders/${order.id}/pickup/confirm`).set(auth(otherOwner.token)).send({})).status).toBe(404);
    expect((await request(app).post(`/api/v1/orders/${order.id}/pickup/confirm`).set(auth(otherCustomer.token)).send({})).status).toBe(404);
    expect((await request(app).post(`/api/v1/orders/${duplicateOrder.id}/pickup/confirm`).set(auth(owner.token)).send({})).body.error.code).toBe('ORDER_NOT_READY');
    await prisma.printOrder.update({where:{id:duplicateOrder.id},data:{orderStatus:'READY_FOR_PICKUP'}});
    const unpaidPickup = await request(app).post(`/api/v1/orders/${duplicateOrder.id}/pickup/confirm`).set(auth(customer.token)).send({});
    expect(unpaidPickup.status).toBe(409);
    expect(unpaidPickup.body.error.code).toBe('PAYMENT_NOT_VERIFIED');
    await prisma.payment.updateMany({where:{orderId:duplicateOrder.id},data:{status:'SUCCEEDED',reviewStatus:'APPROVED'}});
    const customerPickup = await request(app).post(`/api/v1/orders/${duplicateOrder.id}/pickup/confirm`).set(auth(customer.token)).send({confirmedByUserId:owner.user.id,confirmedByRole:'SHOP_OWNER'});
    expect(customerPickup.status).toBe(200);
    expect(customerPickup.body.data.order.pickupConfirmedByUserId).toBe(customer.user.id);
    expect(customerPickup.body.data.order.pickupConfirmedByRole).toBe('CUSTOMER');
    expect((await request(app).post(`/api/v1/orders/${order.id}/pickup/verify`).set(auth(owner.token)).send({ token: pickupValue })).status).toBe(410);
    const pickup = await request(app).post(`/api/v1/orders/${order.id}/pickup/confirm`).set(auth(owner.token)).send({ confirmedByUserId: customer.user.id, confirmedByRole: 'CUSTOMER' });
    expect(pickup.status).toBe(200);
    expect(pickup.body.data.order.orderStatus).toBe('COMPLETED');
    expect(pickup.body.data.order.pickupConfirmedByUserId).toBe(owner.user.id);
    expect(pickup.body.data.order.pickupConfirmedByRole).toBe('SHOP_OWNER');
    expect(pickup.body.data.order.pickupConfirmedAt).toBeTruthy();
    const repeatedPickup = await request(app).post(`/api/v1/orders/${order.id}/pickup/confirm`).set(auth(customer.token)).send({});
    expect(repeatedPickup.status).toBe(200);
    expect(repeatedPickup.body.data.idempotent).toBe(true);
    expect(repeatedPickup.body.data.order.pickupConfirmedByUserId).toBe(owner.user.id);
    expect(await prisma.pickupToken.findUnique({ where: { orderId: order.id } })).toMatchObject({ consumedAt: null });
    expect(await prisma.auditLog.count({ where: { entityId: order.id, action: 'PICKUP_CONFIRMED_MANUALLY' } })).toBe(1);
    expect((await request(app).post(`/api/v1/orders/${order.id}/pickup/disputes`).set(auth(customer.token)).send({reason:'The package was marked picked up in error.'})).status).toBe(201);
    expect((await request(app).get('/api/v1/admin/disputes').set(auth(customer.token))).status).toBe(403);
    const disputes = await request(app).get('/api/v1/admin/disputes').set(auth(adminToken));
    expect(disputes.status).toBe(200);
    const dispute = disputes.body.data.disputes.find(item=>item.orderId===order.id);
    expect(dispute).toBeTruthy();
    const reviewed = await request(app).patch(`/api/v1/admin/disputes/${dispute.id}`).set(auth(adminToken)).send({status:'RESOLVED',resolutionNotes:'Reviewed with the customer and assigned shop owner.'});
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.data.dispute.status).toBe('RESOLVED');
  }, 60_000);
});
