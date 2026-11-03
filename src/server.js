import {app} from './app.js';
import {config} from './config.js';
import {prisma} from './db.js';
const server=app.listen(config.PORT,()=>console.log(`PrintReady API listening on http://localhost:${config.PORT}/api/v1`));
server.on('error',error=>{
  if(error.code==='EADDRINUSE')console.error(`[server] Port ${config.PORT} is already in use. Stop the existing listener or set a different PORT.`);
  else console.error(`[server] Failed to start (${error.code??'unknown error'}).`);
  process.exit(1);
});
async function shutdown(){server.close(async()=>{await prisma.$disconnect();process.exit(0)})}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
