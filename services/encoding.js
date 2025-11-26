import fs from "fs";
import chardet from "chardet";
import iconv from "iconv-lite";

export function normalizeEncoding(filePath) {
  const buffer = fs.readFileSync(filePath);
  const detected = chardet.detect(buffer) || "UTF-8";
  return iconv.decode(buffer, detected);
}
