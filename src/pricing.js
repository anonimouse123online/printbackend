import { fail } from './errors.js';
export function calculateLine({pageCount,copies,paperSize,colorMode,printSides,bindingType},pricing){
  if(!Number.isInteger(copies)||copies<1||copies>500)fail(422,'VALIDATION_ERROR','Copies must be between 1 and 500');
  if(!Number.isInteger(pageCount)||pageCount<1)fail(422,'VALIDATION_ERROR','Invalid page count');
  const pages=pageCount*copies;
  const rates=pricing.rates??{};
  const key=[paperSize,colorMode,printSides].join(':');
  const rate=rates[key];
  if(!Number.isInteger(rate)||rate<0)fail(422,'SERVICE_UNAVAILABLE','Selected print configuration is not priced');
  const binding= bindingType ? (pricing.bindingCents?.[bindingType] ?? null) : 0;
  if(binding===null)fail(422,'SERVICE_UNAVAILABLE','Selected binding is not available');
  return pages*rate + binding*copies;
}
