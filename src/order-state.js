import { fail } from './errors.js';
export const transitions={SUBMITTED:['AWAITING_PAYMENT','REJECTED','CANCELLED'],AWAITING_PAYMENT:['PAID','CANCELLED'],PAID:['IN_QUEUE','REFUND_PENDING'],IN_QUEUE:['PRINTING','REFUND_PENDING'],PRINTING:['READY_FOR_PICKUP','REFUND_PENDING'],READY_FOR_PICKUP:['COMPLETED'],REFUND_PENDING:['REFUNDED'],DRAFT:['SUBMITTED','CANCELLED'],COMPLETED:[],REJECTED:[],CANCELLED:[],REFUNDED:[]};
export function assertTransition(from,to){if(!transitions[from]?.includes(to))fail(409,'INVALID_STATUS_TRANSITION',`Cannot change order from ${from} to ${to}`)}
