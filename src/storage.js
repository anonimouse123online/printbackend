import {mkdir,writeFile,readFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {config} from './config.js';
const root=path.resolve(config.LOCAL_STORAGE_DIR);
export async function putFile(bytes){await mkdir(root,{recursive:true});const key=`${randomUUID()}.pdf`;await writeFile(path.join(root,key),bytes,{flag:'wx',mode:0o600});return key}
export async function getFile(key){if(!/^[\w-]+\.pdf$/.test(key))throw new Error('Invalid storage key');return readFile(path.join(root,key))}
export async function deleteFile(key){if(!/^[\w-]+\.pdf$/.test(key))return;await unlink(path.join(root,key)).catch(()=>{})}
const privateImageExtensions={ 'image/png':'png', 'image/jpeg':'jpg' };
export async function putPrivateImage(bytes,contentType){const extension=privateImageExtensions[contentType];if(!extension)throw new Error('Unsupported private image type');await mkdir(root,{recursive:true});const key=`${randomUUID()}.${extension}`;await writeFile(path.join(root,key),bytes,{flag:'wx',mode:0o600});return key}
export async function getPrivateImage(key){if(!/^[\w-]+\.(?:png|jpg)$/.test(key))throw new Error('Invalid private image key');return readFile(path.join(root,key))}
export async function deletePrivateImage(key){if(!/^[\w-]+\.(?:png|jpg)$/.test(key))return;await unlink(path.join(root,key)).catch(()=>{})}
export const storageMode=config.STORAGE_DRIVER;
