import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** 飞书事件加密体系（Lark 官方方案）：key = SHA256(encrypt_key)，AES-256-CBC，IV = 密文前 16 字节 */
function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/** 解密飞书回调里的 encrypt 字段（base64），返回明文 JSON 字符串 */
export function decryptLark(encryptB64: string, encryptKey: string): string {
  const key = sha256(encryptKey);
  const data = Buffer.from(encryptB64, "base64");
  if (data.length <= 16) throw new Error("密文过短，缺少 IV");
  const decipher = createDecipheriv("aes-256-cbc", key, data.subarray(0, 16));
  return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString("utf8");
}

/** 加密（测试与自检用；与飞书的加密方案对称） */
export function encryptLark(plain: string, encryptKey: string): string {
  const key = sha256(encryptKey);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
}

/** 回调签名：sha256(timestamp + nonce + encrypt_key + body原文)，hex */
export function larkSignature(timestamp: string, nonce: string, encryptKey: string, body: string): string {
  return createHash("sha256").update(timestamp + nonce + encryptKey + body, "utf8").digest("hex");
}
