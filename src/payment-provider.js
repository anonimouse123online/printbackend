import {config} from './config.js';
import {randomUUID} from 'node:crypto';
export function getPaymentProvider(){
 if(config.PAYMENT_PROVIDER==='development')return {name:'development',async checkout(){throw new Error('Payments are disabled until a verified payment provider is configured.')},verifyWebhook(){return false}};
 if(config.PAYMENT_PROVIDER==='paymongo'||config.PAYMENT_PROVIDER==='maya')return {name:config.PAYMENT_PROVIDER,async checkout(){throw new Error('Provider credentials/adapter are not configured. Configure a verified hosted-checkout adapter before accepting payments.')},verifyWebhook(raw,signature){if(!config.PAYMENT_WEBHOOK_SECRET||!signature)return false;return false}};
 throw new Error(`Unsupported payment provider: ${config.PAYMENT_PROVIDER}`)
}
