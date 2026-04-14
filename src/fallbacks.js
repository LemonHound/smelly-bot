const EMOJIS = [':dash:', ':cloud:', ':poop:', ':wind_blowing_face:', ':nauseated_face:', ':exploding_head:'];
const SNARKS = ["brain's offline,", "can't think right now,", "no thoughts, head empty,", "system's clogged,", "processing error,"];
const EXCUSES = ['ate too much fiber', 'stuck in the loo', 'methane overload', 'gastric emergency', 'severe flatulence event', 'bowel maintenance mode'];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function composeFallback() {
  return `${pick(EMOJIS)} ${pick(SNARKS)} ${pick(EXCUSES)}`;
}
