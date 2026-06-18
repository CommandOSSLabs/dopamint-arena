// Shim cho các module hệ thống của Node.js (được gọi bởi các công cụ Bench/Sim của sui-tunnel-ts)
// Trình duyệt không có các module này, nên ta cung cấp các object rỗng để không bị lỗi lúc evaluate import.

export const Worker = class {};
export const cpus = () => [];
export const join = (...args: string[]) => args.join("/");
export const readFile = async () => "";
export const writeFile = async () => {};

export default {
  Worker,
  cpus,
  join,
  readFile,
  writeFile,
};
