-- Rollback de 0002_client_provisioning_grants.sql
-- Seguro en cualquier momento -- REVOKE nunca destruye datos, solo
-- retira el privilegio. Si se ejecuta mientras el endpoint está en uso,
-- las próximas escrituras de POST /clientes fallarán con permission
-- denied (comportamiento esperado, no un error de esta migración).

revoke insert on agx.membresias from agx_auth;
revoke insert on agx.cuentas from agx_auth;
revoke insert on agx.organizaciones from agx_auth;
