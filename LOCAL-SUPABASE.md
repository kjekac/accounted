# Local Supabase Development

This project can run against a local Supabase stack instead of Supabase Cloud.
The Supabase CLI owns the Docker services; Nix only pins the host tools.

## First setup

Start Docker first. Nix provides the Docker client, but it does not run the
Docker daemon. `docker --version` only checks the client; `docker info` is the
useful check because it verifies that the Docker socket is reachable.

```bash
nix develop
docker info
npm ci
npm run db:local:start
cp .env.local.example .env.local
```

On NixOS, a working Docker client usually means the package is installed, not
that the daemon is enabled. Start it for the current boot with:

```bash
sudo systemctl start docker
```

For a persistent NixOS setup, enable Docker in your NixOS configuration:

```nix
virtualisation.docker.enable = true;
users.users.<your-user>.extraGroups = [ "docker" ];
```

Then rebuild and start a new login shell so group membership is refreshed.

### Rootless Docker

Rootless Docker uses a per-user socket, usually:

```bash
unix:///run/user/$(id -u)/docker.sock
```

The Nix dev shell automatically sets `DOCKER_HOST` to that socket when it
exists and `DOCKER_HOST` is not already set. You can verify the value with:

```bash
echo "$DOCKER_HOST"
docker info
```

Outside the Nix shell, export it manually if the Supabase CLI tries
`/var/run/docker.sock`:

```bash
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
npm run db:local:start
```

Your `docker info` output should show `Security Options: rootless`. If it also
warns that IPv4 forwarding is disabled, container startup may work but container
networking can fail later; fix that in the host/NixOS rootless Docker setup.

`npm audit fix` is not part of the local Supabase setup. Run it only on a
separate dependency-maintenance branch, because it rewrites `package-lock.json`.

Paste the `anon` and `service_role` keys printed by `supabase start` into
`.env.local`, then start the app:

```bash
npm run dev
```

Useful local URLs:

- App: http://localhost:3000
- Supabase API: http://127.0.0.1:54321
- Supabase Studio: http://127.0.0.1:54323
- Mail UI: http://127.0.0.1:54324
- Postgres: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`

## Common commands

```bash
npm run db:local:start   # start Supabase containers
npm run db:local:status  # print local URLs and keys
npm run db:local:reset   # rebuild DB from migrations and seed.sql
npm run db:local:stop    # stop containers without deleting local data
```

To run pg-real tests against the local database:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:pg
```

## Troubleshooting

If onboarding fails with `permission denied for table companies`, apply the
latest migrations or reset the local database:

```bash
npm run db:local:reset
```

That error means the Supabase API role reached an RLS-protected table without
the matching table-level grants.

## Notes

- `.env.local` is intentionally ignored. Commit `.env.local.example` only.
- `supabase/config.toml`, `supabase/seed.sql`, and migrations are project state
  and should stay in this repo.
- Use the self-hosting Docker guidance in `SELF-HOSTING.md` for production.
  This setup is for local development.
