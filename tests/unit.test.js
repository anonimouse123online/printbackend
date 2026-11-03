import {describe,it,expect} from 'vitest';
import {calculateLine} from '../src/pricing.js';
import {assertTransition} from '../src/order-state.js';
import {provisionInitialAdmin} from '../src/admin-provisioning.js';

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
