export function detectDelimiter(content) {
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let maxCount = 0;

  for (let d of candidates) {
    const count = content.split(d).length;
    if (count > maxCount) {
      maxCount = count;
      best = d;
    }
  }
  return best;
}
