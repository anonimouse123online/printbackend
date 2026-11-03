import {app} from './app.js';
import {config} from './config.js';
import {prisma} from './db.js';
import {cleanupExpiredDocuments} from './retention.js';
const server=app.listen(config.PORT,'0.0.0.0',()=>console.log(`PrintReady API listening on port ${config.PORT}`));
const cleanupTimer=setInterval(()=>{void cleanupExpiredDocuments().catch(error=>console.error(`[retention] cleanup failed (${error.code??'unknown'})`))},config.STORAGE_CLEANUP_INTERVAL_MS);
cleanupTimer.unref();
void cleanupExpiredDocuments().catch(error=>console.error(`[retention] cleanup failed (${error.code??'unknown'})`));
server.on('error',error=>{
  if(error.code==='EADDRINUSE')console.error(`[server] Port ${config.PORT} is already in use. Stop the existing listener or set a different PORT.`);
  else console.error(`[server] Failed to start (${error.code??'unknown error'}).`);
  process.exit(1);
});
let shuttingDown=false;
async function shutdown(){if(shuttingDown)return;shuttingDown=true;clearInterval(cleanupTimer);server.close(async()=>{await prisma.$disconnect();process.exit(0)})}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
