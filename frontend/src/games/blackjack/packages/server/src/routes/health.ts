import { json } from "../router";
export const health = async () => json({ status: "OK" });
