import {describe,it,expect} from 'vitest';
import {calculateLine} from '../src/pricing.js';
import {assertTransition} from '../src/order-state.js';
import {provisionInitialAdmin} from '../src/admin-provisioning.js';
import {parseClamReply} from '../src/antivirus.js';
import {createDemoModeGate} from '../src/demo-mode.js';

describe('authoritative printing prices',()=>{
 const pricing={rates:{'A4:BW:SINGLE':200,'A4:COLOR:DOUBLE':800},bindingCents:{comb:2500}};
 it('calculates pages, copies, and binding in integer minor units',()=>expect(calculateLine({pageCount:3,copies:2,paperSize:'A4',colorMode:'BW',printSides:'SINGLE',bindingType:'comb'},pricing)).toBe(6200));
 it('rejects unpriced combinations',()=>expect(()=>calculateLine({pageCount:1,copies:1,paperSize:'Letter',colorMode:'BW',printSides:'SINGLE'},pricing)).toThrow());
 it('rejects invalid copy count',()=>expect(()=>calculateLine({pageCount:2,copies:0,paperSize:'A4',colorMode:'BW',printSides:'SINGLE'},pricing)).toThrow());
});
describe('order state machine',()=>{
 it('allows shop confirmation and pickup completion',()=>{expect(()=>assertTransition('SUBMITTED','AWAITING_PAYMENT')).not.toThrow();expect(()=>assertTransition('READY_FOR_PICKUP','COMPLETED')).not.toThrow()});
 it('rejects payment bypass and duplicate completion',()=>{expect(()=>assertTransition('SUBMITTED','PAID')).toThrow();expect(()=>assertTransition('COMPLETED','COMPLETED')).toThrow()});
});
describe('malware scanner responses',()=>{
 it('accepts only an explicit clean verdict',()=>expect(parseClamReply('stream: OK')).toMatchObject({clean:true,engine:'clamav'}));
 it('rejects detected malware without returning a signature name',()=>expect(parseClamReply('stream: Eicar-Test-Signature FOUND')).toEqual({clean:false}));
 it('fails closed for scanner errors',()=>expect(()=>parseClamReply('stream: ERROR')).toThrow('Malware scanner returned an invalid response'));
});
describe('demo mode route gate',()=>{
 const run=(method,{allowRead=false,enabled=true}={})=>{
  const calls={next:0,status:null,json:null,authenticated:0};
  const res={status(code){calls.status=code;return this},json(body){calls.json=body;return this}};
  const gate=createDemoModeGate({enabled,allowRead,feature:'Document uploads and downloads',authenticate(_req,_res,next){calls.authenticated++;next()}});
  gate({method},res,()=>calls.next++);
  return calls;
 };
 it('authenticates then blocks document writes and reads with 503',()=>{
  for(const method of ['GET','POST','PUT','PATCH','DELETE']){
   const result=run(method);
   expect(result).toMatchObject({authenticated:1,status:503,next:0});
   expect(result.json.error.code).toBe('DEMO_MODE_UNAVAILABLE');
  }
 });
 it('keeps safe order reads available and blocks every order mutation',()=>{
  for(const method of ['GET','HEAD','OPTIONS'])expect(run(method,{allowRead:true})).toMatchObject({next:1,authenticated:0,status:null});
  for(const method of ['POST','PUT','PATCH','DELETE'])expect(run(method,{allowRead:true})).toMatchObject({next:0,authenticated:1,status:503});
 });
 it('is transparent when demo mode is off',()=>expect(run('POST',{enabled:false})).toMatchObject({next:1,authenticated:0,status:null}));
});
describe('initial administrator provisioning',()=>{
 const makeDb = ({locked=true, existing=null, adminCount=0}={}) => {
  const user={id:'admin-test-id',email:'admin@example.test',role:'ADMIN'};
  const tx={
   $queryRaw: async (strings, ...values) => {
    expect(strings.join('?')).toContain('pg_try_advisory_xact_lock');
    expect(strings.join('?')).toContain('AS locked');
    return [{locked}];
   },
   user:{findUnique:async()=>existing,count:async()=>adminCount,create:async({data})=>{expect(data.role).toBe('ADMIN');expect(data.passwordHash).toBe('hashed-value');return user;}},
   auditLog:{create:async()=>({})},
  };
  return {tx,$transaction:async(callback,options)=>{expect(options.isolationLevel).toBe('ReadCommitted');return callback(tx);}};
 };
 it('uses a Boolean advisory lock and creates only an ADMIN inside the transaction',async()=>{
  const result=await provisionInitialAdmin({db:makeDb(),email:'admin@example.test',passwordHash:'hashed-value'});
  expect(result.role).toBe('ADMIN');
 });
 it('stops safely when the provisioning lock is unavailable',async()=>{
  await expect(provisionInitialAdmin({db:makeDb({locked:false}),email:'admin@example.test',passwordHash:'hashed-value'})).rejects.toThrow(/attempt is in progress/);
 });
 it('does not duplicate or promote existing accounts',async()=>{
  await expect(provisionInitialAdmin({db:makeDb({existing:{role:'ADMIN'}}),email:'admin@example.test',passwordHash:'hashed-value'})).rejects.toThrow(/administrator already exists with that email/);
  await expect(provisionInitialAdmin({db:makeDb({existing:{role:'CUSTOMER'}}),email:'admin@example.test',passwordHash:'hashed-value'})).rejects.toThrow(/not promoted/);
  await expect(provisionInitialAdmin({db:makeDb({adminCount:1}),email:'admin@example.test',passwordHash:'hashed-value'})).rejects.toThrow(/One-time provisioning/);
 });
});
