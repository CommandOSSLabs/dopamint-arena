/** `?engine=worker` opts a game window into the worker-hosted tunnel client. Read once at
 *  module load (the flag is stable for the session). */
export function engineEnabled(): boolean {
  return (
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("engine") === "worker"
  );
}
