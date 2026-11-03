import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import {z} from 'zod';
import {randomBytes,createHash,randomUUID, timingSafeEqual,createHmac} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {fileTypeFromBuffer} from 'file-type';
import {prisma} from './db.js';
import {config,trustedOrigins} from './config.js';
import {authenticate,allowRoles,hashPassword,verifyPassword,issueToken,publicUser} from './auth.js';
import {asyncRoute,AppError,fail} from './errors.js';
import {createQuarantineKey,putFile,promoteFile,getFile,deleteFile,putPrivateImage,getPrivateImage,deletePrivateImage,checkStorage} from './storage.js';
import {scanBuffer,checkMalwareScanner} from './antivirus.js';
import {calculateLine} from './pricing.js';
import {assertTransition} from './order-state.js';
import {getPaymentProvider} from './payment-provider.js';
import {createDemoModeGate} from './demo-mode.js';

export const app=express();
app.disable('x-powered-by'); if(config.NODE_ENV==='production')app.set('trust proxy',1); app.use(helmet()); app.use(cors({origin(origin,cb){if(!origin||trustedOrigins.includes(origin))return cb(null,true);cb(new AppError(403,'CORS_ORIGIN_DENIED','Origin is not allowed'))},credentials:true})); app.use(pinoHttp({redact:{paths:['req.headers.authorization','req.headers.cookie'],remove:true},customProps(){const {rss,heapUsed,external}=process.memoryUsage();return {processMemory:{rss,heapUsed,external}}}}));
app.use('/api/v1/payments/webhook',express.raw({type:'application/json',limit:'256kb'})); app.use(express.json({limit:'1mb'}));
const api=express.Router();app.use('/api/v1',api);
api.use('/payments/webhook/:provider',(req,res,next)=>next(new AppError(503,'PAYMENT_NOT_CONFIGURED','Payments are disabled until a provider-specific checkout and webhook adapter is implemented')));
api.use('/orders', createDemoModeGate({enabled:config.DEMO_MODE, authenticate, feature:'Order and payment changes', allowRead:true}));
api.use('/orders/:orderId/files/:fileId', createDemoModeGate({enabled:config.DEMO_MODE, authenticate, feature:'Document downloads'}));
api.use('/files', createDemoModeGate({enabled:config.DEMO_MODE, authenticate, feature:'Document uploads and downloads'}));
const authLimiter=rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:true,legacyHeaders:false});
const parse=(schema,data)=>{const r=schema.safeParse(data);if(!r.success)fail(422,'VALIDATION_ERROR','Request validation failed',r.error.flatten()) ;return r.data};
const wrap=(schema,source='body')=> (req,res,next)=>{try{req.validated=parse(schema,req[source]);next()}catch(e){next(e)}};
const ok=(res,data,status=200)=>res.status(status).json({data});
const contentDisposition=(name)=>{const fallback=name.replace(/["\\/\r\n\0]/g,'_').replace(/[^\x20-\x7e]/g,'_').slice(0,180)||'document.pdf';const encoded=encodeURIComponent(name).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`};
const listPageSchema=z.object({limit:z.coerce.number().int().min(1).max(200).default(100),cursor:z.string().max(512).optional()});
function pageCursor(cursor){
  if(!cursor)return null;
  try{
    const parsed=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
    if(typeof parsed.id!=='string'||typeof parsed.createdAt!=='string'||Number.isNaN(Date.parse(parsed.createdAt)))throw new Error('invalid cursor');
    return {id:parsed.id,createdAt:new Date(parsed.createdAt)};
  }catch{fail(422,'INVALID_CURSOR','Pagination cursor is invalid');}
}
function cursorWhere(cursor,direction='desc'){
  if(!cursor)return undefined;
  const comparison=direction==='asc'?'gt':'lt';
  return {OR:[{createdAt:{[comparison]:cursor.createdAt}},{createdAt:cursor.createdAt,id:{[comparison]:cursor.id}}]};
}
function pageResult(rows,limit){
  const hasMore=rows.length>limit;
  const items=rows.slice(0,limit);
  const last=items.at(-1);
  const nextCursor=hasMore&&last?Buffer.from(JSON.stringify({id:last.id,createdAt:last.createdAt.toISOString()})).toString('base64url'):null;
  return {items, pagination:{limit,hasMore,nextCursor}};
}
const auth=authenticate;
const audit=async(actorId,action,entityType,entityId,metadata)=>prisma.auditLog.create({data:{actorId,action,entityType,entityId,metadata}});
const publicShop=({paymentQrStorageKey,paymentMethod,paymentRecipientName,paymentWalletNumber,...shop})=>shop;
const orderInclude={items:{include:{file:{select:{id:true,originalFilename:true,pageCount:true}},service:{select:{serviceName:true,serviceType:true}}}},shop:{select:{id:true,shopName:true,city:true}},history:true};
const qrUploadLimiter=rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:true,legacyHeaders:false});
const documentUploadLimiter=rateLimit({windowMs:15*60*1000,limit:8,standardHeaders:true,legacyHeaders:false});
const paymentProofLimiter=rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:true,legacyHeaders:false});
const chatLimiter=rateLimit({windowMs:60*1000,limit:30,standardHeaders:true,legacyHeaders:false});
let activePdfValidations=0;
async function validatePdfBounded(buffer,logger){
  if(activePdfValidations>=config.MAX_CONCURRENT_PDF_VALIDATIONS)fail(503,'PDF_VALIDATION_BUSY','Document validation is temporarily busy; retry shortly');
  activePdfValidations++;
  const startedAt=performance.now();
  try{return await PDFDocument.load(buffer,{ignoreEncryption:false,updateMetadata:false})}
  finally{
    activePdfValidations--;
    const {rss,heapUsed,external}=process.memoryUsage();
    logger?.info({event:'pdf_validation_complete',durationMs:Math.round(performance.now()-startedAt),activePdfValidations,rss,heapUsed,external},'PDF validation completed');
  }
}
async function imageUpload(req,res,{field,maxBytes,required=true}) {
  if(!req.is('multipart/form-data'))fail(415,'UNSUPPORTED_MEDIA_TYPE',`Upload an image using multipart/form-data field "${field}"`);
  const multer=(await import('multer')).default;
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:maxBytes,files:1,fields:8}}).single(field);
  await new Promise((resolve,reject)=>upload(req,res,error=>error?reject(error.code==='LIMIT_FILE_SIZE'?new AppError(413,'FILE_TOO_LARGE','Image exceeds the upload limit'):error):resolve()));
  if(!req.file){if(required)fail(422,'VALIDATION_ERROR',`Image field "${field}" is required`);return null;}
  const type=await fileTypeFromBuffer(req.file.buffer);
  if(!['image/png','image/jpeg'].includes(type?.mime)||req.file.mimetype!==type.mime)fail(415,'INVALID_IMAGE','Only PNG and JPEG images are accepted');
  if(type.mime==='image/png'){
    const b=req.file.buffer;
    if(b.length<24||b.readUInt32BE(16)<1||b.readUInt32BE(20)<1||b.readUInt32BE(16)>4096||b.readUInt32BE(20)>4096||b.readUInt32BE(16)*b.readUInt32BE(20)>12000000)fail(422,'INVALID_IMAGE','Image dimensions are invalid or too large');
  } else {
    const b=req.file.buffer;let offset=2,dimensions=null;
    if(b.length<4||b[0]!==0xff||b[1]!==0xd8)fail(422,'INVALID_IMAGE','JPEG image is malformed');
    while(offset+4<b.length){
      if(b[offset]!==0xff){offset++;continue;}
      while(b[offset]===0xff)offset++;
      const marker=b[offset++];
      if(marker===0xd9||marker===0xda)break;
      if(offset+2>b.length)break;
      const segmentLength=b.readUInt16BE(offset);
      if(segmentLength<2||offset+segmentLength>b.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&segmentLength>=7){dimensions={height:b.readUInt16BE(offset+3),width:b.readUInt16BE(offset+5)};break;}
      offset+=segmentLength;
    }
    if(!dimensions||dimensions.width<1||dimensions.height<1||dimensions.width>4096||dimensions.height>4096||dimensions.width*dimensions.height>12000000)fail(422,'INVALID_IMAGE','JPEG dimensions are invalid or too large');
  }
  return {buffer:req.file.buffer,contentType:type.mime};
}

api.get('/health',(req,res)=>ok(res,{status:'ok'}));
let infrastructureProbeAt=0;
let infrastructureProbe;
function checkInfrastructure(){
  if(infrastructureProbe&&Date.now()-infrastructureProbeAt<15000)return infrastructureProbe;
  infrastructureProbeAt=Date.now();
  infrastructureProbe=Promise.all([checkStorage(),checkMalwareScanner()]).then(()=>true,()=>false);
  return infrastructureProbe;
}
api.get('/health/ready',asyncRoute(async(req,res)=>{try{await prisma.$queryRaw`SELECT 1`;if(config.DEMO_MODE)ok(res,{status:'ready',mode:'demo',database:'connected',documentStorage:'disabled',malwareScanner:'disabled'});else{if(!await checkInfrastructure())throw new Error('Infrastructure dependency unavailable');ok(res,{status:'ready',database:'connected',storage:'connected',malwareScanner:'connected'})}}catch{res.status(503).json({error:{code:'DEPENDENCY_UNAVAILABLE',message:'A required service is unavailable'}})}}));
api.post('/auth/register',authLimiter,wrap(z.object({fullName:z.string().trim().min(2).max(120),email:z.string().email().transform(v=>v.toLowerCase()),password:z.string().min(12).max(128)})),asyncRoute(async(req,res)=>{const d=req.validated;if(await prisma.user.findUnique({where:{email:d.email}}))fail(409,'EMAIL_EXISTS','An account already uses this email');const user=await prisma.user.create({data:{fullName:d.fullName,email:d.email,passwordHash:await hashPassword(d.password),role:'CUSTOMER'}});ok(res,{user:publicUser(user),token:issueToken(user)},201)}));
api.post('/auth/register/shop-owner',authLimiter,wrap(z.object({fullName:z.string().trim().min(2).max(120),email:z.string().email().transform(v=>v.toLowerCase()),password:z.string().min(12).max(128)})),asyncRoute(async(req,res)=>{const d=req.validated;if(await prisma.user.findUnique({where:{email:d.email}}))fail(409,'EMAIL_EXISTS','An account already uses this email');const user=await prisma.user.create({data:{fullName:d.fullName,email:d.email,passwordHash:await hashPassword(d.password),role:'SHOP_OWNER'}});ok(res,{user:publicUser(user),token:issueToken(user)},201)}));
api.post('/auth/login',authLimiter,wrap(z.object({email:z.string().email(),password:z.string().min(1)})),asyncRoute(async(req,res)=>{const user=await prisma.user.findUnique({where:{email:req.validated.email.toLowerCase()}});if(!user||!(await verifyPassword(req.validated.password,user.passwordHash)))fail(401,'INVALID_CREDENTIALS','Email or password is incorrect');if(user.accountStatus!=='ACTIVE')fail(403,'ACCOUNT_UNAVAILABLE','Account is unavailable');ok(res,{user:publicUser(user),token:issueToken(user)})}));
api.post('/auth/logout',auth,(req,res)=>ok(res,{loggedOut:true}));api.get('/auth/me',auth,(req,res)=>ok(res,{user:publicUser(req.user)}));
api.patch('/users/me',auth,wrap(z.object({fullName:z.string().trim().min(2).max(120).optional()})),asyncRoute(async(req,res)=>{const user=await prisma.user.update({where:{id:req.user.id},data:req.validated});ok(res,{user:publicUser(user)})}));
api.post('/shops',auth,allowRoles('SHOP_OWNER'),wrap(z.object({shopName:z.string().min(2).max(160),description:z.string().max(3000).optional(),address:z.string().min(4),city:z.string().min(2),latitude:z.number().min(-90).max(90).optional(),longitude:z.number().min(-180).max(180).optional(),contactNumber:z.string().max(40).optional()})),asyncRoute(async(req,res)=>{const shop=await prisma.printingShop.create({data:{...req.validated,ownerId:req.user.id}});await audit(req.user.id,'SHOP_REGISTERED','shop',shop.id);ok(res,{shop},201)}));
api.get('/shops',asyncRoute(async(req,res)=>{
  const q=parse(z.object({city:z.string().optional(),lat:z.coerce.number().min(-90).max(90).optional(),lng:z.coerce.number().min(-180).max(180).optional(),radiusKm:z.coerce.number().min(1).max(100).default(25),limit:z.coerce.number().int().min(1).max(100).default(100),cursor:z.string().max(512).optional()}),req.query);
  const cursor=pageCursor(q.cursor);
  const geoWhere=q.lat===undefined||q.lng===undefined?null:{OR:[{latitude:null},{longitude:null},{latitude:{gte:Math.max(-90,q.lat-q.radiusKm/110.5),lte:Math.min(90,q.lat+q.radiusKm/110.5)},longitude:{gte:Math.max(-180,q.lng-q.radiusKm/(111*Math.max(0.01,Math.cos(q.lat*Math.PI/180)))),lte:Math.min(180,q.lng+q.radiusKm/(111*Math.max(0.01,Math.cos(q.lat*Math.PI/180))))}}]};
  const where={verificationStatus:'VERIFIED',operatingStatus:'OPEN',...(q.city?{city:{contains:q.city,mode:'insensitive'}}:{}),AND:[...(cursor?[cursorWhere(cursor)]:[]),...(geoWhere?[geoWhere]:[])]};
  const rows=await prisma.printingShop.findMany({where,include:{services:{where:{isAvailable:true}}},orderBy:[{createdAt:'desc'},{id:'desc'}],take:q.limit+1});
  const page=pageResult(rows,q.limit);
  let shops=page.items;
  if(q.lat!==undefined&&q.lng!==undefined)shops=shops.map(s=>({...s,distanceKm:s.latitude==null||s.longitude==null?null:distance(q.lat,q.lng,s.latitude,s.longitude)})).filter(s=>s.distanceKm===null||s.distanceKm<=q.radiusKm).sort((a,b)=>(a.distanceKm??9999)-(b.distanceKm??9999));
  ok(res,{shops:shops.map(publicShop),pagination:page.pagination});
}));
const distance=(a,b,c,d)=>{const r=x=>x*Math.PI/180;const p=Math.sin(r(c-a)/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(r(d-b)/2)**2;return 6371*2*Math.atan2(Math.sqrt(p),Math.sqrt(1-p))};
api.get('/shops/:id',asyncRoute(async(req,res)=>{const shop=await prisma.printingShop.findFirst({where:{id:req.params.id,verificationStatus:'VERIFIED'},include:{services:{where:{isAvailable:true}},hours:true}});if(!shop)fail(404,'NOT_FOUND','Shop not found');ok(res,{shop:publicShop(shop)})}));
api.patch('/shops/:id',auth,allowRoles('SHOP_OWNER'),asyncRoute(async(req,res)=>{const shop=await prisma.printingShop.findUnique({where:{id:req.params.id}});if(!shop)fail(404,'NOT_FOUND','Shop not found');if(shop.ownerId!==req.user.id)fail(403,'FORBIDDEN','This shop does not belong to you');const data=parse(z.object({shopName:z.string().min(2).max(160).optional(),description:z.string().max(3000).nullable().optional(),address:z.string().min(4).optional(),city:z.string().min(2).optional(),latitude:z.number().min(-90).max(90).nullable().optional(),longitude:z.number().min(-180).max(180).nullable().optional(),contactNumber:z.string().max(40).nullable().optional(),operatingStatus:z.enum(['OPEN','PAUSED','CLOSED']).optional()}),req.body);ok(res,{shop:publicShop(await prisma.printingShop.update({where:{id:shop.id},data}))})}));
api.put('/shops/:id/payment-qr',auth,allowRoles('SHOP_OWNER'),qrUploadLimiter,asyncRoute(async(req,res)=>{
  const shop=await prisma.printingShop.findUnique({where:{id:req.params.id}});
  if(!shop)fail(404,'NOT_FOUND','Shop not found');
  if(shop.ownerId!==req.user.id)fail(404,'NOT_FOUND','Shop not found');
  if(shop.verificationStatus!=='VERIFIED')fail(409,'SHOP_NOT_VERIFIED','Only verified shops can configure payment QR details');
  const image=await imageUpload(req,res,{field:'qrImage',maxBytes:2*1024*1024});
  const data=parse(z.object({paymentMethod:z.enum(['GCASH','MAYA']),recipientName:z.string().trim().min(2).max(120),walletNumber:z.string().trim().max(40).optional()}),req.body);
  const key=await putPrivateImage(image.buffer,image.contentType);
  try {
    const updated=await prisma.$transaction(async tx=>{
      const saved=await tx.printingShop.update({where:{id:shop.id},data:{paymentQrStorageKey:key,paymentMethod:data.paymentMethod,paymentRecipientName:data.recipientName,paymentWalletNumber:data.walletNumber??null}});
      await tx.auditLog.create({data:{actorId:req.user.id,action:'SHOP_PAYMENT_QR_UPDATED',entityType:'shop',entityId:shop.id,metadata:{paymentMethod:data.paymentMethod}}});
      return saved;
    });
    ok(res,{paymentQr:{paymentMethod:updated.paymentMethod,recipientName:updated.paymentRecipientName,walletNumber:updated.paymentWalletNumber,configured:true}});
  } catch(error) { await deletePrivateImage(key); throw error; }
}));
api.get('/shops/:id/services',asyncRoute(async(req,res)=>{ok(res,{services:await prisma.shopService.findMany({where:{shopId:req.params.id,isAvailable:true}})})}));
api.put('/shops/:id/services',auth,allowRoles('SHOP_OWNER'),asyncRoute(async(req,res)=>{const shop=await prisma.printingShop.findUnique({where:{id:req.params.id}});if(!shop)fail(404,'NOT_FOUND','Shop not found');if(shop.ownerId!==req.user.id)fail(403,'FORBIDDEN','This shop does not belong to you');const {services}=parse(z.object({services:z.array(z.object({serviceName:z.string().min(2),serviceType:z.string().min(2),isAvailable:z.boolean().default(true),pricingConfiguration:z.object({rates:z.record(z.string(),z.number().int().nonnegative()),bindingCents:z.record(z.string(),z.number().int().nonnegative()).optional()})})).max(50)}),req.body);await prisma.$transaction([prisma.shopService.deleteMany({where:{shopId:shop.id}}),prisma.shopService.createMany({data:services.map(s=>({...s,shopId:shop.id}))})]);ok(res,{services:await prisma.shopService.findMany({where:{shopId:shop.id}})})}));
api.put('/shops/:id/hours',auth,allowRoles('SHOP_OWNER'),asyncRoute(async(req,res)=>{const shop=await prisma.printingShop.findUnique({where:{id:req.params.id}});if(!shop)fail(404,'NOT_FOUND','Shop not found');if(shop.ownerId!==req.user.id)fail(403,'FORBIDDEN','This shop does not belong to you');const {hours}=parse(z.object({hours:z.array(z.object({weekday:z.number().int().min(0).max(6),opensAt:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),closesAt:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),closed:z.boolean()})).max(7)}),req.body);await prisma.$transaction([prisma.shopOperatingHour.deleteMany({where:{shopId:shop.id}}),prisma.shopOperatingHour.createMany({data:hours.map(h=>({...h,shopId:shop.id}))})]);ok(res,{hours:await prisma.shopOperatingHour.findMany({where:{shopId:shop.id}})})}));

api.post('/files',auth,allowRoles('CUSTOMER'),documentUploadLimiter,asyncRoute(async(req,res)=>{
  if(!req.is('multipart/form-data'))fail(415,'UNSUPPORTED_MEDIA_TYPE','Upload a PDF as multipart/form-data field "file"');
  const multer=(await import('multer')).default;
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:config.MAX_UPLOAD_BYTES,files:1,fields:2,parts:3}}).single('file');
  await new Promise((resolve,reject)=>upload(req,res,error=>error?reject(error):resolve()));
  if(!req.file)fail(422,'VALIDATION_ERROR','PDF file is required');
  const type=await fileTypeFromBuffer(req.file.buffer);
  if(req.file.mimetype!=='application/pdf'||type?.mime!=='application/pdf'||req.file.buffer.subarray(0,5).toString()!=='%PDF-')fail(415,'INVALID_FILE','File contents are not a PDF');

  const storageKey=createQuarantineKey();
  const filename=req.file.originalname.replace(/[\\/\0\r\n]/g,'_').replace(/["<>]/g,'_').slice(0,255)||'document.pdf';
  const expiresAt=new Date(Date.now()+config.FILE_RETENTION_DAYS*86400000);
  const file=await prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${req.user.id}, 0))) AS lock_call`;
    const usage=await tx.documentFile.aggregate({where:{uploadedById:req.user.id,scanStatus:{in:['QUARANTINED','AVAILABLE']}},_sum:{fileSize:true}});
    if((usage._sum.fileSize??0)+req.file.size>config.USER_STORAGE_QUOTA_BYTES)fail(413,'STORAGE_QUOTA_EXCEEDED','Your document storage quota has been reached');
    return tx.documentFile.create({data:{uploadedById:req.user.id,storageKey,originalFilename:filename,contentType:'application/pdf',fileSize:req.file.size,pageCount:0,scanStatus:'QUARANTINED',expiresAt}});
  });

  let approvedKey=null;
  try{
    await putFile(req.file.buffer,storageKey);
    const verdict=await scanBuffer(req.file.buffer);
    if(!verdict.clean)fail(422,'MALWARE_DETECTED','The uploaded document did not pass the security scan');
    let pdf;
    try{pdf=await validatePdfBounded(req.file.buffer,req.log)}catch(error){if(error.code==='PDF_VALIDATION_BUSY')throw error;fail(422,'INVALID_PDF','PDF is invalid, encrypted, or cannot be safely parsed')}
    const pageCount=pdf.getPageCount();
    if(pageCount<1||pageCount>2000)fail(422,'INVALID_PDF','PDF must contain 1 to 2000 pages');
    approvedKey=await promoteFile(storageKey);
    const available=await prisma.documentFile.update({where:{id:file.id},data:{storageKey:approvedKey,pageCount,scanStatus:'AVAILABLE',scannedAt:new Date()}});
    ok(res,{file:{id:available.id,originalFilename:available.originalFilename,fileSize:available.fileSize,pageCount:available.pageCount,expiresAt:available.expiresAt}},201);
  }catch(error){
    await Promise.allSettled([deleteFile(storageKey),...(approvedKey?[deleteFile(approvedKey)]:[])]);
    await prisma.documentFile.updateMany({where:{id:file.id,scanStatus:'QUARANTINED'},data:{scanStatus:'REJECTED',scannedAt:new Date()}});
    throw error;
  }
}));
api.get('/files/:id',auth,asyncRoute(async(req,res)=>{const file=await prisma.documentFile.findUnique({where:{id:req.params.id},include:{items:{include:{order:{include:{shop:true}}}}}});if(!file||file.scanStatus!=='AVAILABLE')fail(404,'NOT_FOUND','File not found');const allowed=file.uploadedById===req.user.id||req.user.role==='ADMIN'||(req.user.role==='SHOP_OWNER'&&file.items.some(i=>i.order.shop.ownerId===req.user.id&&['PAID','IN_QUEUE','PRINTING','READY_FOR_PICKUP'].includes(i.order.orderStatus)));if(!allowed)fail(404,'NOT_FOUND','File not found');if(file.expiresAt<new Date()&&!file.items.some(item=>!['COMPLETED','REJECTED','CANCELLED','REFUNDED'].includes(item.order.orderStatus)))fail(410,'FILE_EXPIRED','File has expired');const bytes=await getFile(file.storageKey);res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':contentDisposition(file.originalFilename)}).type('application/pdf').send(bytes)}));
api.get('/orders/:orderId/files/:fileId',auth,asyncRoute(async(req,res)=>{const order=await scopedOrder(req.params.orderId,req.user,['CUSTOMER','SHOP_OWNER']);const file=await prisma.documentFile.findUnique({where:{id:req.params.fileId},include:{items:{select:{orderId:true,order:{select:{orderStatus:true}}}}}});if(!file||file.scanStatus!=='AVAILABLE'||!file.items.some(item=>item.orderId===order.id))fail(404,'NOT_FOUND','File not found');if(file.expiresAt<new Date()&&['COMPLETED','REJECTED','CANCELLED','REFUNDED'].includes(order.orderStatus))fail(410,'FILE_EXPIRED','File has expired');const bytes=await getFile(file.storageKey);res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':contentDisposition(file.originalFilename)}).type('application/pdf').send(bytes)}));
api.delete('/files/:id',auth,asyncRoute(async(req,res)=>{const file=await prisma.documentFile.findUnique({where:{id:req.params.id},include:{items:true}});if(!file||file.uploadedById!==req.user.id&&req.user.role!=='ADMIN')fail(404,'NOT_FOUND','File not found');if(file.items.length)fail(409,'FILE_IN_USE','Files attached to an order cannot be deleted');await deleteFile(file.storageKey);await prisma.documentFile.delete({where:{id:file.id}});ok(res,{deleted:true})}));

api.post('/orders',auth,allowRoles('CUSTOMER'),wrap(z.object({shopId:z.string(),items:z.array(z.object({fileId:z.string(),serviceId:z.string(),paperSize:z.string(),colorMode:z.enum(['BW','COLOR']),printSides:z.enum(['SINGLE','DOUBLE']),copies:z.number().int().min(1).max(500),pageRange:z.string().max(200).optional(),bindingType:z.string().optional(),specialInstructions:z.string().max(1000).optional()})).min(1).max(20)})),asyncRoute(async(req,res)=>{const d=req.validated;const shop=await prisma.printingShop.findUnique({where:{id:d.shopId},include:{services:true}});if(!shop||shop.verificationStatus!=='VERIFIED'||shop.operatingStatus!=='OPEN')fail(404,'SHOP_UNAVAILABLE','Shop is not accepting orders');const fileIds=[...new Set(d.items.map(item=>item.fileId))];const files=await prisma.documentFile.findMany({where:{id:{in:fileIds},uploadedById:req.user.id,scanStatus:'AVAILABLE',expiresAt:{gt:new Date()}},select:{id:true,pageCount:true}});const filesById=new Map(files.map(file=>[file.id,file]));const rows=[];let total=0;for(const i of d.items){const file=filesById.get(i.fileId);if(!file)fail(404,'FILE_NOT_FOUND','An uploaded file is unavailable');const service=shop.services.find(s=>s.id===i.serviceId&&s.isAvailable);if(!service)fail(422,'SERVICE_UNAVAILABLE','Service is unavailable');let pages=file.pageCount;if(i.pageRange){const m=i.pageRange.match(/^(\d+)(?:-(\d+))?$/);if(!m)fail(422,'VALIDATION_ERROR','Page range must be a page or start-end range');const start=+m[1],end=+(m[2]||m[1]);if(start<1||end<start||end>file.pageCount)fail(422,'VALIDATION_ERROR','Page range exceeds document page count');pages=end-start+1}const lineTotalCents=calculateLine({...i,pageCount:pages},service.pricingConfiguration);total+=lineTotalCents;rows.push({...i,pageCount:pages,lineTotalCents})}if(!Number.isSafeInteger(total)||total<1)fail(422,'INVALID_TOTAL','Calculated order total is invalid');const ref=`PR-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex').toUpperCase()}`;const order=await prisma.$transaction(async tx=>{const o=await tx.printOrder.create({data:{orderReference:ref,customerId:req.user.id,shopId:shop.id,subtotalCents:total,totalCents:total,orderStatus:'SUBMITTED',items:{create:rows}}});await tx.orderStatusHistory.create({data:{orderId:o.id,toStatus:'SUBMITTED',changedById:req.user.id}});await tx.auditLog.create({data:{actorId:req.user.id,action:'ORDER_SUBMITTED',entityType:'order',entityId:o.id}});return tx.printOrder.findUnique({where:{id:o.id},include:orderInclude})});ok(res,{order},201)}));
api.get('/orders',auth,asyncRoute(async(req,res)=>{const q=parse(listPageSchema,req.query);const cursor=pageCursor(q.cursor);const where={...(req.user.role==='ADMIN'?{}:req.user.role==='CUSTOMER'?{customerId:req.user.id}:{shop:{ownerId:req.user.id}}),...(cursor?cursorWhere(cursor):{})};const page=pageResult(await prisma.printOrder.findMany({where,include:orderInclude,orderBy:[{createdAt:'desc'},{id:'desc'}],take:q.limit+1}),q.limit);ok(res,{orders:page.items,pagination:page.pagination})}));
api.get('/orders/:id',auth,asyncRoute(async(req,res)=>{const order=await prisma.printOrder.findUnique({where:{id:req.params.id},include:{...orderInclude,customer:{select:{id:true,fullName:true,email:true}},shop:{select:{id:true,shopName:true,city:true,ownerId:true,verificationStatus:true,paymentQrStorageKey:true,paymentMethod:true,paymentRecipientName:true,paymentWalletNumber:true}}}});if(!order)fail(404,'NOT_FOUND','Order not found');if(req.user.role==='CUSTOMER'&&order.customerId!==req.user.id||req.user.role==='SHOP_OWNER'&&order.shop.ownerId!==req.user.id)fail(404,'NOT_FOUND','Order not found');const {ownerId,paymentQrStorageKey,paymentMethod,paymentRecipientName,paymentWalletNumber,...shop}=order.shop;const shopDetails=req.user.role==='SHOP_OWNER'?{...shop,paymentQrConfigured:!!(paymentQrStorageKey&&paymentMethod&&paymentRecipientName),paymentMethod,paymentRecipientName,paymentWalletNumber}:shop;ok(res,{order:{...order,shop:shopDetails}})}));
async function scopedOrder(id,user,roles){const order=await prisma.printOrder.findUnique({where:{id},include:{shop:true}});if(!order)fail(404,'NOT_FOUND','Order not found');if(user.role==='CUSTOMER'&&order.customerId!==user.id||user.role==='SHOP_OWNER'&&order.shop.ownerId!==user.id)fail(404,'NOT_FOUND','Order not found');if(roles&&!roles.includes(user.role))fail(403,'FORBIDDEN','Insufficient permissions');return order}
async function changeStatus(id,user,to,reason){const o=await scopedOrder(id,user);assertTransition(o.orderStatus,to);return prisma.$transaction(async tx=>{const updated=await tx.printOrder.updateMany({where:{id,orderStatus:o.orderStatus},data:{orderStatus:to}});if(!updated.count)fail(409,'CONCURRENT_UPDATE','Order changed concurrently');await tx.orderStatusHistory.create({data:{orderId:id,fromStatus:o.orderStatus,toStatus:to,changedById:user.id,reason}});await tx.auditLog.create({data:{actorId:user.id,action:`ORDER_${to}`,entityType:'order',entityId:id}});if(to==='READY_FOR_PICKUP')await tx.notification.create({data:{userId:o.customerId,type:'ORDER_READY_FOR_PICKUP',payload:{orderId:id,orderReference:o.orderReference}}});return tx.printOrder.findUnique({where:{id},include:orderInclude})})}
api.patch('/orders/:id/confirm',auth,allowRoles('SHOP_OWNER'),asyncRoute(async(req,res)=>{
  const order=await scopedOrder(req.params.id,req.user,['SHOP_OWNER']);
  if(order.shop.ownerId!==req.user.id)fail(404,'NOT_FOUND','Order not found');
  if(order.orderStatus==='AWAITING_PAYMENT'){
    const payment=await prisma.payment.findFirst({where:{orderId:order.id,provider:'manual_qr'}});
    if(payment){ok(res,{order,payment:{id:payment.id,amountCents:payment.amountCents,currency:payment.currency,reviewStatus:payment.reviewStatus}});return;}
  }
  if(order.orderStatus!=='SUBMITTED')fail(409,'INVALID_STATUS_TRANSITION',`Cannot change order from ${order.orderStatus} to AWAITING_PAYMENT`);
  const shop=await prisma.printingShop.findUnique({where:{id:order.shopId}});
  if(shop?.verificationStatus!=='VERIFIED')fail(409,'SHOP_NOT_VERIFIED','The shop must be verified before confirming orders');
  if(shop.operatingStatus!=='OPEN')fail(409,'SHOP_NOT_ACCEPTING_ORDERS','The shop is not currently accepting orders');
  const quotedOrder=await prisma.printOrder.findUnique({where:{id:order.id},include:{items:{include:{service:true}}}});
  if(!quotedOrder?.items.length)fail(409,'ORDER_PRICE_INVALID','Order has no priced printing items');
  let recomputedTotal=0;
  for(const item of quotedOrder.items){
    if(!item.service||item.service.shopId!==shop.id||!item.service.isAvailable)fail(409,'ORDER_SERVICE_UNAVAILABLE','A service on this order is no longer available');
    let currentLineTotal;
    try{currentLineTotal=calculateLine(item,item.service.pricingConfiguration)}catch{fail(409,'ORDER_PRICE_CHANGED','The current service pricing no longer matches this order. Ask the customer to submit a new order.');}
    if(currentLineTotal!==item.lineTotalCents)fail(409,'ORDER_PRICE_CHANGED','The current service pricing no longer matches this order. Ask the customer to submit a new order.');
    recomputedTotal+=currentLineTotal;
  }
  if(!Number.isSafeInteger(recomputedTotal)||recomputedTotal<1||quotedOrder.subtotalCents!==recomputedTotal||quotedOrder.totalCents!==recomputedTotal)fail(409,'ORDER_PRICE_INVALID','The stored order total does not match its printing items');
  if(!shop?.paymentQrStorageKey||!shop.paymentMethod||!shop.paymentRecipientName)fail(409,'PAYMENT_QR_NOT_CONFIGURED','Configure shop payment QR details before confirming orders');
  const result=await prisma.$transaction(async tx=>{
    const changed=await tx.printOrder.updateMany({where:{id:order.id,orderStatus:'SUBMITTED'},data:{orderStatus:'AWAITING_PAYMENT'}});
    if(!changed.count){
      const current=await tx.printOrder.findUnique({where:{id:order.id},include:orderInclude});
      const existingPayment=await tx.payment.findFirst({where:{orderId:order.id,provider:'manual_qr'}});
      if(current?.orderStatus==='AWAITING_PAYMENT'&&existingPayment)return {order:current,payment:{id:existingPayment.id,amountCents:existingPayment.amountCents,currency:existingPayment.currency,reviewStatus:existingPayment.reviewStatus}};
      fail(409,'CONCURRENT_UPDATE','Order changed concurrently');
    }
    const payment=await tx.payment.create({data:{orderId:order.id,provider:'manual_qr',amountCents:order.totalCents,currency:order.currency,recipientNameSnapshot:shop.paymentRecipientName,walletNumberSnapshot:shop.paymentWalletNumber,paymentMethodSnapshot:shop.paymentMethod,recipientQrStorageKey:shop.paymentQrStorageKey}});
    await tx.orderStatusHistory.create({data:{orderId:order.id,fromStatus:'SUBMITTED',toStatus:'AWAITING_PAYMENT',changedById:req.user.id}});
    await tx.auditLog.create({data:{actorId:req.user.id,action:'ORDER_CONFIRMED_AWAITING_MANUAL_PAYMENT',entityType:'order',entityId:order.id,metadata:{paymentId:payment.id,amountCents:payment.amountCents,currency:payment.currency}}});
    const updated=await tx.printOrder.findUnique({where:{id:order.id},include:orderInclude});
    return {order:updated,payment:{id:payment.id,amountCents:payment.amountCents,currency:payment.currency,reviewStatus:null}};
  });
  ok(res,result);
}));api.patch('/orders/:id/reject',auth,allowRoles('SHOP_OWNER'),asyncRoute(async(req,res)=>{ok(res,{order:await changeStatus(req.params.id,req.user,'REJECTED',req.body?.reason)})}));
api.patch('/orders/:id/status',auth,allowRoles('SHOP_OWNER'),asyncRoute(async(req,res)=>{const {status}=parse(z.object({status:z.enum(['IN_QUEUE','PRINTING','READY_FOR_PICKUP'])}),req.body);ok(res,{order:await changeStatus(req.params.id,req.user,status)})}));
api.post('/orders/:id/cancel',auth,asyncRoute(async(req,res)=>{const o=await scopedOrder(req.params.id,req.user);if(!['CUSTOMER','ADMIN'].includes(req.user.role)&&o.shop.ownerId!==req.user.id)fail(403,'FORBIDDEN','Insufficient permissions');if(['PAID','IN_QUEUE','PRINTING','READY_FOR_PICKUP'].includes(o.orderStatus))fail(409,'REFUND_REQUIRED','Paid orders require an administrator refund workflow');ok(res,{order:await changeStatus(req.params.id,req.user,'CANCELLED','Customer/owner cancellation')})}));
api.post('/orders/:id/pickup/confirm',auth,asyncRoute(async(req,res)=>{
  if(!['CUSTOMER','SHOP_OWNER'].includes(req.user.role))fail(403,'FORBIDDEN','Only the order customer or assigned shop owner can confirm pickup');
  const authorized=await scopedOrder(req.params.id,req.user,['CUSTOMER','SHOP_OWNER']);
  const recipientId=req.user.role==='CUSTOMER'?authorized.shop.ownerId:authorized.customerId;
  const result=await prisma.$transaction(async tx=>{
    const current=await tx.printOrder.findUnique({where:{id:authorized.id},include:{shop:true}});
    if(!current)fail(404,'NOT_FOUND','Order not found');
    if(current.orderStatus==='COMPLETED')return {order:await tx.printOrder.findUnique({where:{id:current.id},include:orderInclude}),idempotent:true};
    if(current.orderStatus!=='READY_FOR_PICKUP')fail(409,'ORDER_NOT_READY','Order must be ready for pickup before confirmation');
    const payment=await tx.payment.findFirst({where:{orderId:current.id,status:'SUCCEEDED'}});
    if(!payment)fail(409,'PAYMENT_NOT_VERIFIED','Verified payment is required before pickup confirmation');
    const confirmedAt=new Date();
    const updated=await tx.printOrder.updateMany({where:{id:current.id,orderStatus:'READY_FOR_PICKUP',pickupConfirmedAt:null},data:{orderStatus:'COMPLETED',pickupConfirmedByUserId:req.user.id,pickupConfirmedByRole:req.user.role,pickupConfirmedAt:confirmedAt}});
    if(!updated.count){
      const latest=await tx.printOrder.findUnique({where:{id:current.id},include:orderInclude});
      if(latest?.orderStatus==='COMPLETED')return {order:latest,idempotent:true};
      fail(409,'CONCURRENT_UPDATE','Pickup confirmation changed concurrently');
    }
    await tx.orderStatusHistory.create({data:{orderId:current.id,fromStatus:'READY_FOR_PICKUP',toStatus:'COMPLETED',changedById:req.user.id,reason:'Manual pickup confirmation by authenticated order participant'}});
    await tx.auditLog.create({data:{actorId:req.user.id,action:'PICKUP_CONFIRMED_MANUALLY',entityType:'order',entityId:current.id,metadata:{confirmedByRole:req.user.role,paymentId:payment.id}}});
    await tx.notification.create({data:{userId:recipientId,type:'PICKUP_CONFIRMED',payload:{orderId:current.id,orderReference:current.orderReference,confirmedByRole:req.user.role}}});
    return {order:await tx.printOrder.findUnique({where:{id:current.id},include:orderInclude}),idempotent:false};
  });
  ok(res,result);
}));
api.post('/orders/:id/pickup/verify',(req,res)=>fail(410,'PICKUP_TOKEN_RETIRED','Pickup tokens are historical only. Use POST /orders/:id/pickup/confirm.'));
api.post('/orders/:id/pickup/disputes',auth,asyncRoute(async(req,res)=>{
  const order=await scopedOrder(req.params.id,req.user,['CUSTOMER','SHOP_OWNER']);
  if(order.orderStatus!=='COMPLETED'||!order.pickupConfirmedAt)fail(409,'PICKUP_NOT_CONFIRMED','Only a manually confirmed pickup can be disputed');
  const {reason}=parse(z.object({reason:z.string().trim().min(10).max(2000)}),req.body);
  const existing=await prisma.pickupDispute.findUnique({where:{orderId:order.id}});
  if(existing){ok(res,{dispute:existing,idempotent:true});return;}
  try{
    const dispute=await prisma.$transaction(async tx=>{
      const created=await tx.pickupDispute.create({data:{orderId:order.id,openedById:req.user.id,reason}});
      await tx.auditLog.create({data:{actorId:req.user.id,action:'PICKUP_DISPUTE_OPENED',entityType:'pickup_dispute',entityId:created.id,metadata:{orderId:order.id}}});
      return created;
    });
    ok(res,{dispute,idempotent:false},201);
  }catch(error){if(error.code==='P2002'){const dispute=await prisma.pickupDispute.findUnique({where:{orderId:order.id}});ok(res,{dispute,idempotent:true});return;}throw error;}
}));

const messageOrder=async(id,user)=>{
  if(!['CUSTOMER','SHOP_OWNER'].includes(user.role))fail(403,'FORBIDDEN','Only the order customer and assigned shop owner can use order chat');
  const order=await scopedOrder(id,user,['CUSTOMER','SHOP_OWNER']);
  return {order,recipientId:user.role==='CUSTOMER'?order.shop.ownerId:order.customerId};
};
api.get('/orders/messages/unread-count',auth,asyncRoute(async(req,res)=>{
  if(!['CUSTOMER','SHOP_OWNER'].includes(req.user.role))fail(403,'FORBIDDEN','Order chat is available only to order participants');
  const groups=await prisma.orderMessage.groupBy({by:['orderId'],where:{recipientId:req.user.id,readAt:null},_count:{_all:true}});
  ok(res,{unreadCount:groups.reduce((sum,g)=>sum+g._count._all,0),byOrder:groups.map(g=>({orderId:g.orderId,count:g._count._all}))});
}));
api.get('/orders/:id/messages',auth,asyncRoute(async(req,res)=>{
  const {order}=await messageOrder(req.params.id,req.user);
  const query=parse(z.object({limit:z.coerce.number().int().min(1).max(100).default(50),before:z.string().datetime().optional(),beforeId:z.string().optional(),after:z.string().datetime().optional(),afterId:z.string().optional()}),req.query);
  if(query.before&&query.after)fail(422,'VALIDATION_ERROR','Use before or after, not both');
  if(query.beforeId&&!query.before||query.afterId&&!query.after)fail(422,'VALIDATION_ERROR','A message ID cursor requires its matching timestamp');
  const beforeDate=query.before?new Date(query.before):null,afterDate=query.after?new Date(query.after):null;
  const where={orderId:order.id,...(beforeDate?{OR:query.beforeId?[{createdAt:{lt:beforeDate}},{createdAt:beforeDate,id:{lt:query.beforeId}}]:[{createdAt:{lt:beforeDate}}]}:{}),...(afterDate?{AND:[{OR:query.afterId?[{createdAt:{gt:afterDate}},{createdAt:afterDate,id:{gt:query.afterId}}]:[{createdAt:{gt:afterDate}}]}]}:{})};
  const direction=query.after?'asc':'desc';
  const rows=await prisma.orderMessage.findMany({where,orderBy:[{createdAt:direction},{id:direction}],take:query.limit+1,include:{sender:{select:{id:true,fullName:true,role:true}}}});
  const hasMore=rows.length>query.limit; let messages=rows.slice(0,query.limit);
  if(direction==='desc')messages.reverse();
  const unread=messages.filter(m=>m.recipientId===req.user.id&&m.readAt===null);
  if(unread.length){const readAt=new Date();await prisma.orderMessage.updateMany({where:{id:{in:unread.map(m=>m.id)},recipientId:req.user.id,readAt:null},data:{readAt}});messages=messages.map(m=>m.readAt===null&&m.recipientId===req.user.id?{...m,readAt}:m);}
  ok(res,{messages,hasMore,nextBefore:!query.after&&hasMore?messages[0]?.createdAt:null,nextBeforeId:!query.after&&hasMore?messages[0]?.id:null,nextAfter:query.after&&hasMore?messages.at(-1)?.createdAt:null,nextAfterId:query.after&&hasMore?messages.at(-1)?.id:null});
}));
api.post('/orders/:id/messages',auth,chatLimiter,wrap(z.object({message:z.string().trim().min(1).max(4000)})),asyncRoute(async(req,res)=>{
  const {order,recipientId}=await messageOrder(req.params.id,req.user);
  const message=await prisma.orderMessage.create({data:{orderId:order.id,senderId:req.user.id,recipientId,body:req.validated.message},include:{sender:{select:{id:true,fullName:true,role:true}}}});
  ok(res,{message},201);
}));

api.get('/orders/:id/payment-instructions',auth,asyncRoute(async(req,res)=>{
  const order=await scopedOrder(req.params.id,req.user,['CUSTOMER']);
  if(order.customerId!==req.user.id)fail(404,'NOT_FOUND','Order not found');
  if(order.orderStatus!=='AWAITING_PAYMENT')fail(409,'ORDER_NOT_PAYABLE','Payment instructions are available only while awaiting payment');
  const payment=await prisma.payment.findFirst({where:{orderId:order.id,provider:'manual_qr'}});
  if(!payment||!payment.recipientQrStorageKey)fail(404,'PAYMENT_INSTRUCTIONS_NOT_FOUND','Shop payment instructions are unavailable');
  ok(res,{payment:{id:payment.id,amountCents:payment.amountCents,currency:payment.currency,reviewStatus:payment.reviewStatus,referenceNumber:payment.referenceNumber},recipient:{method:payment.paymentMethodSnapshot,accountName:payment.recipientNameSnapshot,walletNumber:payment.walletNumberSnapshot},qrImageUrl:`/api/v1/orders/${order.id}/payment-qr`,transferNote:'Transfer directly to the shop using its e-wallet. Funds are not held by PrintReady.'});
}));
api.get('/orders/:id/payment-qr',auth,asyncRoute(async(req,res)=>{
  const order=await scopedOrder(req.params.id,req.user,['CUSTOMER']);
  if(order.customerId!==req.user.id)fail(404,'NOT_FOUND','Order not found');
  if(order.orderStatus!=='AWAITING_PAYMENT')fail(409,'ORDER_NOT_PAYABLE','Shop QR is available only while awaiting payment');
  const payment=await prisma.payment.findFirst({where:{orderId:order.id,provider:'manual_qr'}});
  if(!payment?.recipientQrStorageKey)fail(404,'PAYMENT_QR_NOT_FOUND','Shop payment QR is unavailable');
  const contentType=payment.recipientQrStorageKey.endsWith('.png')?'image/png':'image/jpeg';
  res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).type(contentType).send(await getPrivateImage(payment.recipientQrStorageKey));
}));
api.post('/orders/:id/payments/proof',auth,allowRoles('CUSTOMER'),paymentProofLimiter,asyncRoute(async(req,res)=>{
  const order=await scopedOrder(req.params.id,req.user,['CUSTOMER']);
  if(order.customerId!==req.user.id)fail(404,'NOT_FOUND','Order not found');
  if(order.orderStatus!=='AWAITING_PAYMENT')fail(409,'ORDER_NOT_PAYABLE','Order is not awaiting payment');
  let image=null;
  if(req.is('multipart/form-data'))image=await imageUpload(req,res,{field:'receipt',maxBytes:3*1024*1024,required:false});
  const data=parse(z.object({referenceNumber:z.string().trim().min(4).max(120),note:z.string().trim().max(500).optional()}),req.body);
  const payment=await prisma.payment.findFirst({where:{orderId:order.id,provider:'manual_qr'}});
  if(!payment)fail(409,'PAYMENT_NOT_INITIALIZED','Shop has not initialized manual payment for this order');
  if(payment.reviewStatus==='APPROVED')fail(409,'PAYMENT_ALREADY_APPROVED','Payment has already been approved');
  if(payment.reviewStatus==='PENDING_VERIFICATION'){
    if(payment.referenceNumber===data.referenceNumber){ok(res,{payment:{id:payment.id,reviewStatus:payment.reviewStatus,referenceNumber:payment.referenceNumber,amountCents:payment.amountCents,currency:payment.currency,submittedAt:payment.submittedAt},idempotent:true});return;}
    fail(409,'PAYMENT_SUBMISSION_PENDING','A payment submission is already awaiting shop review');
  }
  const duplicate=await prisma.payment.findUnique({where:{referenceNumber:data.referenceNumber}});
  if(duplicate&&duplicate.id!==payment.id)fail(409,'DUPLICATE_PAYMENT_REFERENCE','This reference number has already been submitted; confirm the transfer details before retrying',{duplicateReferenceWarning:true});
  const proofKey=image?await putPrivateImage(image.buffer,image.contentType):null;
  try{
    const updated=await prisma.$transaction(async tx=>{
      const result=await tx.payment.updateMany({where:{id:payment.id,reviewStatus:payment.reviewStatus},data:{referenceNumber:data.referenceNumber,proofStorageKey:proofKey,reviewStatus:'PENDING_VERIFICATION',status:'PENDING',rejectionReason:null,submittedAt:new Date(),reviewedAt:null,reviewerId:null}});
      if(!result.count)fail(409,'CONCURRENT_UPDATE','Payment changed while the proof was being submitted');
      const row=await tx.payment.findUnique({where:{id:payment.id}});
      await tx.auditLog.create({data:{actorId:req.user.id,action:'MANUAL_PAYMENT_PROOF_SUBMITTED',entityType:'payment',entityId:payment.id,metadata:{orderId:order.id,referenceNumber:data.referenceNumber,hasReceipt:Boolean(proofKey),note:data.note??null}}});
      return row;
    });
    if(payment.proofStorageKey&&payment.proofStorageKey!==proofKey)await deletePrivateImage(payment.proofStorageKey);
    ok(res,{payment:{id:updated.id,reviewStatus:updated.reviewStatus,referenceNumber:updated.referenceNumber,amountCents:updated.amountCents,currency:updated.currency,submittedAt:updated.submittedAt},duplicateReferenceWarning:false},201);
  }catch(error){if(proofKey)await deletePrivateImage(proofKey);if(error.code==='P2002')fail(409,'DUPLICATE_PAYMENT_REFERENCE','This reference number has already been submitted; confirm the transfer details before retrying',{duplicateReferenceWarning:true});throw error;}
}));
api.get('/orders/:id/payment-proof',auth,asyncRoute(async(req,res)=>{
  const order=await scopedOrder(req.params.id,req.user,['CUSTOMER','SHOP_OWNER']);
  if(req.user.role==='CUSTOMER'&&order.customerId!==req.user.id||req.user.role==='SHOP_OWNER'&&order.shop.ownerId!==req.user.id)fail(404,'NOT_FOUND','Order not found');
  const payment=await prisma.payment.findFirst({where:{orderId:order.id,provider:'manual_qr'},select:{proofStorageKey:true}});
  if(!payment?.proofStorageKey)fail(404,'PAYMENT_PROOF_NOT_FOUND','No receipt screenshot was submitted');
  const contentType=payment.proofStorageKey.endsWith('.png')?'image/png':'image/jpeg';
  res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).type(contentType).send(await getPrivateImage(payment.proofStorageKey));
}));
api.patch('/orders/:id/payments/review',auth,allowRoles('SHOP_OWNER'),wrap(z.object({status:z.enum(['APPROVED','REJECTED']),reason:z.string().trim().min(3).max(1000).optional()}).superRefine((v,c)=>{if(v.status==='REJECTED'&&!v.reason)c.addIssue({code:'custom',path:['reason'],message:'A rejection reason is required'});})),asyncRoute(async(req,res)=>{
  const order=await scopedOrder(req.params.id,req.user,['SHOP_OWNER']);
  if(order.shop.ownerId!==req.user.id)fail(404,'NOT_FOUND','Order not found');
  const payment=await prisma.payment.findFirst({where:{orderId:order.id,provider:'manual_qr'}});
  if(!payment)fail(404,'PAYMENT_NOT_FOUND','Manual payment not found');
  const target=req.validated.status;
  if(payment.reviewStatus===target){ok(res,{payment:{id:payment.id,reviewStatus:payment.reviewStatus,status:payment.status,rejectionReason:payment.rejectionReason,reviewedAt:payment.reviewedAt}});return;}
  if(payment.reviewStatus!=='PENDING_VERIFICATION')fail(409,'PAYMENT_NOT_AWAITING_REVIEW','Payment proof is not awaiting review');
  const result=await prisma.$transaction(async tx=>{
    const changed=await tx.payment.updateMany({where:{id:payment.id,reviewStatus:'PENDING_VERIFICATION'},data:{reviewStatus:target,status:target==='APPROVED'?'SUCCEEDED':'FAILED',rejectionReason:target==='REJECTED'?req.validated.reason:null,reviewedAt:new Date(),reviewerId:req.user.id,paidAt:target==='APPROVED'?new Date():null}});
    if(!changed.count)fail(409,'CONCURRENT_UPDATE','Payment review changed concurrently');
    if(target==='APPROVED'){
      const orderUpdate=await tx.printOrder.updateMany({where:{id:order.id,orderStatus:'AWAITING_PAYMENT'},data:{orderStatus:'PAID'}});
      if(!orderUpdate.count)fail(409,'CONCURRENT_UPDATE','Order is no longer awaiting payment');
      await tx.orderStatusHistory.create({data:{orderId:order.id,fromStatus:'AWAITING_PAYMENT',toStatus:'PAID',changedById:req.user.id,reason:'Shop owner verified manual wallet transfer'}});
    }
    await tx.auditLog.create({data:{actorId:req.user.id,action:target==='APPROVED'?'MANUAL_PAYMENT_APPROVED':'MANUAL_PAYMENT_REJECTED',entityType:'payment',entityId:payment.id,metadata:{orderId:order.id,reason:target==='REJECTED'?req.validated.reason:null}}});
    return tx.payment.findUnique({where:{id:payment.id}});
  });
  ok(res,{payment:{id:result.id,reviewStatus:result.reviewStatus,status:result.status,rejectionReason:result.rejectionReason,reviewedAt:result.reviewedAt}});
}));

api.post('/orders/:id/payments/checkout',auth,asyncRoute(async(req,res)=>{const o=await scopedOrder(req.params.id,req.user,['CUSTOMER']);if(o.orderStatus!=='AWAITING_PAYMENT')fail(409,'ORDER_NOT_PAYABLE','Order is not awaiting payment');const payment=await prisma.payment.create({data:{orderId:o.id,provider:config.PAYMENT_PROVIDER,amountCents:o.totalCents,currency:o.currency}});let checkout;try{checkout=await getPaymentProvider().checkout({paymentId:payment.id,orderId:o.id,amountCents:o.totalCents,currency:o.currency})}catch(e){await prisma.payment.delete({where:{id:payment.id}});fail(503,'PAYMENT_NOT_CONFIGURED',e.message)}const updated=await prisma.payment.update({where:{id:payment.id},data:{providerPaymentId:checkout.providerPaymentId,checkoutUrl:checkout.checkoutUrl}});ok(res,{payment:updated},201)}));
api.get('/orders/:id/payments',auth,asyncRoute(async(req,res)=>{const o=await scopedOrder(req.params.id,req.user);ok(res,{payments:await prisma.payment.findMany({where:{orderId:o.id},select:{id:true,provider:true,amountCents:true,currency:true,status:true,reviewStatus:true,referenceNumber:true,rejectionReason:true,submittedAt:true,reviewedAt:true,checkoutUrl:true,paidAt:true,createdAt:true}})})}));
api.post('/payments/webhook/:provider',asyncRoute(async(req,res)=>{const provider=getPaymentProvider();if(req.params.provider!==provider.name)fail(404,'PROVIDER_NOT_FOUND','Provider not configured');const raw=Buffer.isBuffer(req.body)?req.body:Buffer.from(JSON.stringify(req.body));const signature=req.headers['x-payment-signature'];if(!config.PAYMENT_WEBHOOK_SECRET||!signature)fail(401,'INVALID_WEBHOOK','Webhook signature missing');const expected=createHmac('sha256',config.PAYMENT_WEBHOOK_SECRET).update(raw).digest('hex');const supplied=String(signature).replace(/^sha256=/,'');if(expected.length!==supplied.length||!timingSafeEqual(Buffer.from(expected),Buffer.from(supplied)))fail(401,'INVALID_WEBHOOK','Webhook signature invalid');const event=JSON.parse(raw.toString());const data=parse(z.object({id:z.string(),type:z.enum(['payment.succeeded','payment.failed']),paymentId:z.string(),amountCents:z.number().int().positive(),currency:z.string().length(3)}),event);await prisma.$transaction(async tx=>{const created=await tx.paymentWebhookEvent.createMany({data:{provider:provider.name,eventId:data.id},skipDuplicates:true});if(!created.count)return;const p=await tx.payment.findFirst({where:{id:data.paymentId,provider:provider.name},include:{order:true}});if(!p||p.amountCents!==data.amountCents||p.currency!==data.currency)fail(409,'PAYMENT_MISMATCH','Payment does not match order');if(data.type==='payment.succeeded'){if(p.order.orderStatus!=='AWAITING_PAYMENT')return;await tx.payment.update({where:{id:p.id},data:{status:'SUCCEEDED',paidAt:new Date()}});await tx.printOrder.update({where:{id:p.orderId},data:{orderStatus:'PAID'}});await tx.orderStatusHistory.create({data:{orderId:p.orderId,fromStatus:'AWAITING_PAYMENT',toStatus:'PAID',reason:'Verified payment webhook'}})}else await tx.payment.update({where:{id:p.id},data:{status:'FAILED'}})});ok(res,{received:true})}));

api.get('/owner/shops',auth,allowRoles('SHOP_OWNER'),asyncRoute(async(req,res)=>ok(res,{shops:(await prisma.printingShop.findMany({where:{ownerId:req.user.id},include:{services:true,hours:true}})).map(({paymentQrStorageKey,...shop})=>shop)})));api.get('/owner/orders',auth,allowRoles('SHOP_OWNER'),asyncRoute(async(req,res)=>{const q=parse(listPageSchema,req.query);const cursor=pageCursor(q.cursor);const where={shop:{ownerId:req.user.id},...(cursor?cursorWhere(cursor):{})};const page=pageResult(await prisma.printOrder.findMany({where,include:{...orderInclude,customer:{select:{id:true,fullName:true,email:true}},payments:{select:{id:true,status:true,reviewStatus:true,amountCents:true,currency:true,referenceNumber:true,rejectionReason:true}}},orderBy:[{createdAt:'desc'},{id:'desc'}],take:q.limit+1}),q.limit);ok(res,{orders:page.items,pagination:page.pagination})}));api.get('/owner/dashboard',auth,allowRoles('SHOP_OWNER'),asyncRoute(async(req,res)=>{const where={shop:{ownerId:req.user.id}};const [orders,shops]=await Promise.all([prisma.printOrder.groupBy({by:['orderStatus'],where,_count:true}),prisma.printingShop.count({where:{ownerId:req.user.id}})]);ok(res,{shops,ordersByStatus:orders})}));
api.get('/admin/dashboard',auth,allowRoles('ADMIN'),asyncRoute(async(req,res)=>{
  const [users,shops,orders,payments]=await Promise.all([prisma.user.count(),prisma.printingShop.count(),prisma.printOrder.count(),prisma.payment.count({where:{status:'SUCCEEDED'}})]);
  ok(res,{users,shops,orders,successfulPayments:payments});
}));
api.get('/admin/shops/pending',auth,allowRoles('ADMIN'),asyncRoute(async(req,res)=>{const q=parse(listPageSchema,req.query);const cursor=pageCursor(q.cursor);const where={verificationStatus:'PENDING',...(cursor?cursorWhere(cursor,'asc'):{})};const page=pageResult(await prisma.printingShop.findMany({where,include:{owner:{select:{id:true,fullName:true,email:true}},services:true,hours:true,verificationReviewer:{select:{id:true,fullName:true}}},orderBy:[{createdAt:'asc'},{id:'asc'}],take:q.limit+1}),q.limit);ok(res,{shops:page.items,pagination:page.pagination})}));
api.get('/admin/shops/:id',auth,allowRoles('ADMIN'),asyncRoute(async(req,res)=>{
  const shop=await prisma.printingShop.findUnique({where:{id:req.params.id},include:{owner:{select:{id:true,fullName:true,email:true}},services:true,hours:true,verificationReviewer:{select:{id:true,fullName:true,email:true}}}});
  if(!shop)fail(404,'NOT_FOUND','Shop not found');
  ok(res,{shop});
}));
api.patch('/admin/shops/:id/verification',auth,allowRoles('ADMIN'),wrap(z.object({status:z.enum(['VERIFIED','REJECTED']),notes:z.string().trim().max(1000).optional()})),asyncRoute(async(req,res)=>{
  const existing=await prisma.printingShop.findUnique({where:{id:req.params.id}});
  if(!existing)fail(404,'NOT_FOUND','Shop not found');
  if(existing.ownerId===req.user.id)fail(403,'FORBIDDEN','Administrators cannot verify their own shop');
  const shop=await prisma.$transaction(async tx=>{
    const updated=await tx.printingShop.update({where:{id:existing.id},data:{verificationStatus:req.validated.status,verificationReviewedAt:new Date(),verificationReviewerId:req.user.id,verificationNotes:req.validated.notes??null}});
    await tx.auditLog.create({data:{actorId:req.user.id,action:'SHOP_VERIFICATION_UPDATED',entityType:'shop',entityId:updated.id,metadata:{status:updated.verificationStatus,notes:updated.verificationNotes}}});
    return updated;
  });
  ok(res,{shop});
}));
api.get('/admin/orders',auth,allowRoles('ADMIN'),asyncRoute(async(req,res)=>{const q=parse(listPageSchema.extend({limit:z.coerce.number().int().min(1).max(200).default(200)}),req.query);const cursor=pageCursor(q.cursor);const page=pageResult(await prisma.printOrder.findMany({where:cursor?cursorWhere(cursor):{},include:orderInclude,orderBy:[{createdAt:'desc'},{id:'desc'}],take:q.limit+1}),q.limit);ok(res,{orders:page.items,pagination:page.pagination})}));
api.get('/admin/disputes',auth,allowRoles('ADMIN'),asyncRoute(async(req,res)=>{
  const q=parse(listPageSchema,req.query);const cursor=pageCursor(q.cursor);
  const page=pageResult(await prisma.pickupDispute.findMany({where:cursor?cursorWhere(cursor):{},include:{openedBy:{select:{id:true,fullName:true,email:true}},reviewedBy:{select:{id:true,fullName:true}},order:{include:{shop:{select:{id:true,shopName:true}},customer:{select:{id:true,fullName:true,email:true}}}}},orderBy:[{createdAt:'desc'},{id:'desc'}],take:q.limit+1}),q.limit);
  ok(res,{disputes:page.items,pagination:page.pagination});
}));
api.patch('/admin/disputes/:id',auth,allowRoles('ADMIN'),wrap(z.object({status:z.enum(['RESOLVED','DISMISSED']),resolutionNotes:z.string().trim().min(5).max(2000)})),asyncRoute(async(req,res)=>{
  const existing=await prisma.pickupDispute.findUnique({where:{id:req.params.id}});
  if(!existing)fail(404,'NOT_FOUND','Pickup dispute not found');
  if(existing.status!=='OPEN'){
    if(existing.status===req.validated.status){ok(res,{dispute:existing,idempotent:true});return;}
    fail(409,'DISPUTE_ALREADY_REVIEWED','Pickup dispute has already been reviewed');
  }
  const dispute=await prisma.$transaction(async tx=>{
    const changed=await tx.pickupDispute.updateMany({where:{id:existing.id,status:'OPEN'},data:{status:req.validated.status,resolutionNotes:req.validated.resolutionNotes,reviewedById:req.user.id,reviewedAt:new Date()}});
    if(!changed.count)fail(409,'DISPUTE_ALREADY_REVIEWED','Pickup dispute has already been reviewed');
    const updated=await tx.pickupDispute.findUnique({where:{id:existing.id}});
    await tx.auditLog.create({data:{actorId:req.user.id,action:'PICKUP_DISPUTE_REVIEWED',entityType:'pickup_dispute',entityId:updated.id,metadata:{status:updated.status,resolutionNotes:updated.resolutionNotes}}});
    return updated;
  });
  ok(res,{dispute,idempotent:false});
}));
api.post('/reviews',auth,allowRoles('CUSTOMER'),wrap(z.object({orderId:z.string(),rating:z.number().int().min(1).max(5),comment:z.string().max(2000).optional()})),asyncRoute(async(req,res)=>{const o=await prisma.printOrder.findUnique({where:{id:req.validated.orderId}});if(!o||o.customerId!==req.user.id)fail(404,'NOT_FOUND','Order not found');if(o.orderStatus!=='COMPLETED')fail(409,'ORDER_NOT_COMPLETED','Only completed orders can be reviewed');ok(res,{review:await prisma.customerReview.create({data:{...req.validated,customerId:req.user.id,shopId:o.shopId}})},201)}));
app.use((req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'Endpoint not found'}}));
app.use((err,req,res,next)=>{const isUploadLimit=err.name==='MulterError'&&err.code==='LIMIT_FILE_SIZE';const isScannerUnavailable=err.code==='SCANNER_UNAVAILABLE';const status=err.status??(isUploadLimit?413:isScannerUnavailable?503:err.name==='ZodError'?422:500);const code=err.code??(isUploadLimit?'FILE_TOO_LARGE':isScannerUnavailable?'MALWARE_SCANNER_UNAVAILABLE':status===500?'INTERNAL_ERROR':'REQUEST_ERROR');const message=status>=500&&config.NODE_ENV==='production'?'Internal server error':isScannerUnavailable?'Malware scanning is temporarily unavailable; retry later':isUploadLimit?'File exceeds the upload limit':err.message;req.log?.[status>=500?'error':'warn']({err},'request failed');res.status(status).json({error:{code,message,...(err.details?{details:err.details}:{})}})});
