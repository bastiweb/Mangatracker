const crypto = require("crypto");
const path = require("path");

// Run from project root or via docker compose exec manga-tracker node scripts/upsert-admin-user.js ...
const { initDb } = require(path.join("..", "src", "db"));

function buildPasswordHash(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function main() {
  const [emailArg, usernameArg, passwordArg] = process.argv.slice(2);
  const email = String(emailArg || "").trim().toLowerCase();
  const username = String(usernameArg || "").trim();
  const password = String(passwordArg || "");

  if (!email || !email.includes("@")) {
    throw new Error("Usage: node scripts/upsert-admin-user.js <email> <username> <password>");
  }

  if (!username || password.length < 8) {
    throw new Error("Username required and password must be at least 8 chars.");
  }

  const db = await initDb();
  const row = await db.get("SELECT id FROM users WHERE email = ?", [email]);
  const passwordHash = buildPasswordHash(password);

  if (row) {
    await db.run("UPDATE users SET username = ?, role = 'admin', password_hash = ? WHERE id = ?", [
      username,
      passwordHash,
      row.id
    ]);
    console.log(`updated admin user: ${email}`);
    return;
  }

  await db.run("INSERT INTO users (email, username, password_hash, role) VALUES (?, ?, ?, 'admin')", [
    email,
    username,
    passwordHash
  ]);
  console.log(`created admin user: ${email}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
