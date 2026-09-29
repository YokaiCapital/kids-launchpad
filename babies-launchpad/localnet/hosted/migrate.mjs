// One-off owner command: bring the shared registry to this release's schema. Idempotent (each migration runs once, under
// the registry's own guard). The URL comes from KIDS_REGISTRY_URL, else DATABASE_PUBLIC_URL, else DATABASE_URL (what
// `railway ssh --service <service> -- node localnet/hosted/migrate.mjs` sees inside the platform; the database has no public
// address). Hosted services also run this at boot: KIDS_REGISTRY_MIGRATE=1 migrates, the others wait (schema-boot.mjs).
// Nothing is printed but the version numbers.
import {PostgresRegistry,REGISTRY_SCHEMA_VERSION} from '../registry/registry.mjs';
const url=process.env.KIDS_REGISTRY_URL||process.env.DATABASE_PUBLIC_URL||process.env.DATABASE_URL;
if(!/^postgres(ql)?:\/\//.test(url||''))throw Error('KIDS_REGISTRY_URL, DATABASE_PUBLIC_URL or DATABASE_URL must be a PostgreSQL URL');
const registry=new PostgresRegistry({connectionString:url,max:1});
try{
 const before=await registry.schemaVersion().catch(()=>null);
 await registry.migrate();
 const after=await registry.schemaVersion();
 console.log(JSON.stringify({event:'registry-migrated',before,after,release:REGISTRY_SCHEMA_VERSION}));
 if(after!==REGISTRY_SCHEMA_VERSION){console.error('schema '+after+' differs from this release');process.exitCode=1;}
}finally{await registry.close();}
