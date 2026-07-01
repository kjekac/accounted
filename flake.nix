{
  description = "Accounted local development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.docker-client
          pkgs.nodejs_22
          pkgs.openssl
          pkgs.postgresql_17
          pkgs.supabase-cli
        ];

        shellHook = ''
          export SUPABASE_TELEMETRY_DISABLED=1
          if [ -z "''${DOCKER_HOST:-}" ] && [ -S "/run/user/$(id -u)/docker.sock" ]; then
            export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
          fi
          echo "Accounted dev shell: run 'npm ci' once, then 'npm run db:local:start' and 'npm run dev'."
          echo "Supabase local requires a running Docker daemon; check it with 'docker info'."
          if [ -n "''${DOCKER_HOST:-}" ]; then
            echo "Using Docker host: $DOCKER_HOST"
          fi
        '';
      };
    };
}
