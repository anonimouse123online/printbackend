export class AppError extends Error { constructor(status,code,message,details){super(message);this.status=status;this.code=code;this.details=details;} }
export const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
export const fail=(status,code,message,details)=>{throw new AppError(status,code,message,details)};
