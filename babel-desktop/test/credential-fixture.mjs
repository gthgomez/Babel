// License: Apache-2.0
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
// Isolated deterministic-boundary double; this is not evidence of OS protection.
const key=randomBytes(32);
export const fixtureProtection={
  isEncryptionAvailable:()=>true,
  getSelectedStorageBackend:()=> 'gnome_libsecret',
  encryptString(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()]);},
  decryptString(bytes){const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]).toString('utf8');},
};
