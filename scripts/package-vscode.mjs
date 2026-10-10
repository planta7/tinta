import { packageExtension } from "./vscode-package.mjs";
const report = await packageExtension();
console.log(JSON.stringify(report, null, 2));
