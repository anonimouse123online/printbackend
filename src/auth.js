import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { prisma } from './db.js';
import { fail } from './errors.js';
export const hashPassword=password=>bcrypt.hash(password,12);
export const verifyPassword=(password,hash)=>bcrypt.compare(password,hash);
export const issueToken=user=>jwt.sign({sub:user.id,role:user.role},config.JWT_SECRET,{expiresIn:config.JWT_EXPIRES_IN,issuer:'printready'});
export async function authenticate(req,res,next){try{const h=req.headers.authorization;if(!h?.startsWith('Bearer '))return fail(401,'UNAUTHENTICATED','Authentication required');const p=jwt.verify(h.slice(7),config.JWT_SECRET,{issuer:'printready'});const user=await prisma.user.findUnique({where:{id:p.sub}});if(!user||user.accountStatus!=='ACTIVE')return fail(401,'UNAUTHENTICATED','Account is unavailable');req.user=user;next()}catch(e){next(e)}}
export const allowRoles=(...roles)=>(req,res,next)=>roles.includes(req.user?.role)?next():next(Object.assign(new Error('Insufficient permissions'),{status:403,code:'FORBIDDEN'}));
export const publicUser=({passwordHash,...user})=>user;
