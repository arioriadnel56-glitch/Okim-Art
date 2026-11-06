// Usage (racine du dépôt) : node decode-images.js images-base64.json
// Recrée chaque image .webp à son emplacement exact.
const fs = require("fs"), path = require("path");
const data = JSON.parse(fs.readFileSync(process.argv[2] || "images-base64.json", "utf8"));
for (const [file, b64] of Object.entries(data)) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(b64, "base64"));
  console.log("OK", file);
}
