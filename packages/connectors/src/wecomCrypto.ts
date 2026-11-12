import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

/**
 * 企业微信自建应用回调加解密（官方方案，逐字对照 developer.work.weixin.qq.com/document/path/90968）：
 * AESKey = Base64_Decode(EncodingAESKey + "=")（43 字符 EncodingAESKey）；
 * IV = AESKey 前 16 字节；PKCS#7 填充至 32 字节倍数；
 * 明文 = random(16B) + msg_len(4B 网络字节序) + msg + receiveid（企业应用场景 = corpid）；
 * 签名 = sha1(字典序排序(token, timestamp, nonce, msg_encrypt) 拼接) 全小写 hex。
 */

function aesKeyOf(encodingAesKey: string): Buffer {
  const buf = Buffer.from(encodingAesKey + "=", "base64");
  if (buf.length !== 32) throw new Error(`EncodingAESKey 不合法（解码后应 32 字节，实际 ${buf.length}）`);
  return buf;
}

function pkcs7Pad(buf: Buffer, block = 32): Buffer {
  const pad = block - (buf.length % block);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

function pkcs7Unpad(buf: Buffer, block = 32): Buffer {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > block || buf.length < pad) throw new Error("PKCS#7 填充不合法");
  return buf.subarray(0, buf.length - pad);
}

/** 解密回调密文：返回 { msg 明文, receiveid }；receiveid 需由调用方校验 = corpid */
export function wecomDecrypt(encryptB64: string, encodingAesKey: string): { msg: string; receiveid: string } {
  const key = aesKeyOf(encodingAesKey);
  const data = Buffer.from(encryptB64, "base64");
  if (data.length === 0 || data.length % 16 !== 0) throw new Error("密文长度不合法（须为 16 字节倍数）");
  const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const plain = pkcs7Unpad(Buffer.concat([decipher.update(data), decipher.final()]));
  if (plain.length < 20) throw new Error("明文过短（缺 16B 随机串 + 4B 长度）");
  const msgLen = plain.readUInt32BE(16);
  if (20 + msgLen > plain.length) throw new Error("msg_len 越界");
  return {
    msg: plain.subarray(20, 20 + msgLen).toString("utf8"),
    receiveid: plain.subarray(20 + msgLen).toString("utf8"),
  };
}

/** 加密（测试回环用；与官方方案对称） */
export function wecomEncrypt(msg: string, receiveid: string, encodingAesKey: string): string {
  const key = aesKeyOf(encodingAesKey);
  const msgBuf = Buffer.from(msg, "utf8");
  const plain = Buffer.concat([Buffer.alloc(16, 0x01), Buffer.alloc(4), msgBuf, Buffer.from(receiveid, "utf8")]);
  plain.writeUInt32BE(msgBuf.length, 16);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(pkcs7Pad(plain)), cipher.final()]).toString("base64");
}

/** 回调签名：sha1(字典序排序(token, timestamp, nonce, encrypt) 拼接) 全小写 hex */
export function wecomSignature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  const parts = [token, timestamp, nonce, encrypt].sort().join("");
  return createHash("sha1").update(parts, "utf8").digest("hex");
}
