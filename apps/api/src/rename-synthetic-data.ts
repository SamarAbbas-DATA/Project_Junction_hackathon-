import fs from 'node:fs';
import path from 'node:path';
import { SourceStore } from './source-store.js';
import { dataDir,sourceNames } from './config.js';
import { migrateSyntheticIdentifiers } from './migrate-synthetic-identifiers.js';
import { refreshSyntheticFiles } from './refresh-synthetic-files.js';

const stores=Object.fromEntries(sourceNames.map(source=>[source,new SourceStore(source,dataDir)]));
try {
  const result=migrateSyntheticIdentifiers(stores,dataDir);
  const backups=path.join(dataDir,'migrations');
  const backup=result.backup||(fs.existsSync(backups)?fs.readdirSync(backups).filter(n=>n.startsWith('synthetic-identifiers-')).sort().map(n=>path.join(backups,n)).at(-1):null);
  if(backup)refreshSyntheticFiles(backup);
  console.log(JSON.stringify(result,null,2));
}finally{Object.values(stores).forEach(store=>store.close());}
