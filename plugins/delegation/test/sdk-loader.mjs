import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
export const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function loadSdk(){return import(process.env.PI_SDK_PATH?pathToFileURL(path.resolve(process.env.PI_SDK_PATH)).href:'@earendil-works/pi-coding-agent');}
