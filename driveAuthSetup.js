require("dotenv").config();
const readline = require("readline");
const { getAuthUrl, exchangeCodeForToken, saveJSON } = require("./driveAuth");

const tokenPath = process.env.DRIVE_OAUTH_TOKEN_JSON || "./driveToken.json";

(async () => {
  try {
    const url = getAuthUrl();
    console.log("\n✅ Abra este link no navegador e autorize sua conta Google:\n");
    console.log(url);
    console.log("\nDepois copie o CODE que o Google mostrar e cole aqui.\n");

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Cole o CODE aqui: ", async (code) => {
      try {
        const tokens = await exchangeCodeForToken(code.trim());
        saveJSON(tokenPath, tokens);
        console.log(`\n✅ Token salvo em ${tokenPath}. Agora rode: node index.js\n`);
      } catch (e) {
        console.error("\n❌ Erro trocando code por token:", e.message);
      } finally {
        rl.close();
      }
    });
  } catch (e) {
    console.error("\n❌ Erro:", e.message);
  }
})();
