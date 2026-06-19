import { json } from "../router";

export function health(): Response {
  return json({ status: "OK" });
}
