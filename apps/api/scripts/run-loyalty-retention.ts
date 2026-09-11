import { runLoyaltyRetentionSweep } from "../src/loyalty/service.js";

const result = await runLoyaltyRetentionSweep();
console.log(JSON.stringify(result));
