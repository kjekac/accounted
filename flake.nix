{
  description = "Accounted local development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];

      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system:
          f (import nixpkgs { inherit system; }));

      defaultLocalAiModels = [
        "qwen2.5:14b"
        "qwen2.5:32b"
        "llama3.1:8b"
        "mistral-nemo:12b"
      ];

      localAiModelsEnv = nixpkgs.lib.concatStringsSep " " defaultLocalAiModels;

      nodeDeps = pkgs: pkgs.writeShellApplication {
        name = "accounted-node-deps";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.nodejs_22
        ];
        text = ''
          set -euo pipefail

          if [ "''${ACCOUNTED_SKIP_NPM_CI:-0}" = "1" ]; then
            echo "Skipping npm ci because ACCOUNTED_SKIP_NPM_CI=1."
            exit 0
          fi

          if [ ! -f package-lock.json ]; then
            echo "package-lock.json is required for reproducible local-AI eval dependencies." >&2
            exit 1
          fi

          if [ ! -f node_modules/.package-lock.json ] ||
             [ package-lock.json -nt node_modules/.package-lock.json ] ||
             [ package.json -nt node_modules/.package-lock.json ]; then
            echo "Installing npm dependencies with npm ci..."
            npm ci
          else
            echo "npm dependencies already installed."
          fi
        '';
      };

      localAiPrepare = pkgs: pkgs.writeShellApplication {
        name = "accounted-local-ai-prepare";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.curl
          pkgs.ollama
        ];
        text = ''
          set -euo pipefail

          export OLLAMA_HOST="''${OLLAMA_HOST:-127.0.0.1:11434}"

          if ! curl -fsS "http://''${OLLAMA_HOST}/api/tags" >/dev/null 2>&1; then
            log_file="''${TMPDIR:-/tmp}/accounted-ollama.log"
            echo "Starting Ollama on ''${OLLAMA_HOST}..."
            ollama serve >"''${log_file}" 2>&1 &
            for _ in $(seq 1 60); do
              if curl -fsS "http://''${OLLAMA_HOST}/api/tags" >/dev/null 2>&1; then
                break
              fi
              sleep 1
            done
          fi

          if ! curl -fsS "http://''${OLLAMA_HOST}/api/tags" >/dev/null 2>&1; then
            echo "Ollama did not become ready on ''${OLLAMA_HOST}." >&2
            echo "Check ''${TMPDIR:-/tmp}/accounted-ollama.log for details." >&2
            exit 1
          fi

          echo "Ollama is ready on ''${OLLAMA_HOST}."
        '';
      };

      localAiEval = pkgs: pkgs.writeShellApplication {
        name = "accounted-local-ai-eval";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.curl
          pkgs.gnused
          pkgs.ollama
        ];
        text = ''
          set -euo pipefail

          original_arg_count="$#"
          export AI_PROVIDER=local
          export LOCAL_AI_BASE_URL="''${LOCAL_AI_BASE_URL:-http://127.0.0.1:11434/v1}"
          export LOCAL_AI_TIMEOUT_MS="''${LOCAL_AI_TIMEOUT_MS:-120000}"

          models="''${ACCOUNTED_LOCAL_AI_MODELS:-${localAiModelsEnv}}"
          wants_help=0
          for arg in "$@"; do
            if [ "''${arg}" = "--help" ] || [ "''${arg}" = "-h" ]; then
              wants_help=1
            fi
          done

          accounted-node-deps
          if [ "''${wants_help}" != "1" ]; then
            if [ "''${ACCOUNTED_LOCAL_AI_SKIP_PREPARE:-0}" != "1" ]; then
              accounted-local-ai-prepare
            else
              echo "Skipping Ollama startup because ACCOUNTED_LOCAL_AI_SKIP_PREPARE=1."
            fi
          fi

          first_model="''${LOCAL_AI_MODEL:-}"
          if [ -z "''${first_model}" ]; then
            # shellcheck disable=SC2086
            set -- ''${models}
            export LOCAL_AI_MODEL="$1"
          fi

          if [ "''${original_arg_count}" -ne 0 ]; then
            npm run eval:local-ai -- "$@"
            exit 0
          fi

          # Pull just ahead of evaluation. The first model is pulled before
          # its eval; the next model pulls in the background while the current
          # eval runs.
          # shellcheck disable=SC2086
          set -- ''${models}
          while [ "$#" -gt 0 ]; do
            current_model="$1"
            shift

            echo "Ensuring current model: ''${current_model}"
            ollama pull "''${current_model}"

            next_pull_pid=""
            if [ "$#" -gt 0 ]; then
              next_model="$1"
              echo "Pulling next model in background: ''${next_model}"
              ollama pull "''${next_model}" &
              next_pull_pid="$!"
            fi

            export LOCAL_AI_MODEL="''${current_model}"
            npm run eval:local-ai -- --models "''${current_model}"

            if [ -n "''${next_pull_pid}" ]; then
              wait "''${next_pull_pid}"
            fi
          done
        '';
      };
    in
    {
      devShells = forAllSystems (pkgs:
        let
          deps = nodeDeps pkgs;
          prepare = localAiPrepare pkgs;
          eval = localAiEval pkgs;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.docker-client
              pkgs.nodejs_22
              pkgs.openssl
              pkgs.postgresql_17
              pkgs.supabase-cli
              pkgs.tsx
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

          local-ai = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              pkgs.ollama
              pkgs.tsx
              pkgs.gawk
              deps
              prepare
              eval
            ];

            shellHook = ''
              export AI_PROVIDER=local
              export LOCAL_AI_BASE_URL="''${LOCAL_AI_BASE_URL:-http://127.0.0.1:11434/v1}"
              export LOCAL_AI_TIMEOUT_MS="''${LOCAL_AI_TIMEOUT_MS:-120000}"
              export ACCOUNTED_LOCAL_AI_MODELS="''${ACCOUNTED_LOCAL_AI_MODELS:-${localAiModelsEnv}}"
              export LOCAL_AI_MODEL="''${LOCAL_AI_MODEL:-$(printf '%s\n' $ACCOUNTED_LOCAL_AI_MODELS | awk '{print $1}')}"

              echo "Accounted local-AI eval shell"
              echo "  endpoint: $LOCAL_AI_BASE_URL"
              echo "  candidates: $ACCOUNTED_LOCAL_AI_MODELS"
              echo "  run: accounted-local-ai-eval"

              accounted-node-deps

              if [ "''${ACCOUNTED_LOCAL_AI_SKIP_PREPARE:-0}" != "1" ]; then
                accounted-local-ai-prepare
              else
                echo "Skipping Ollama startup because ACCOUNTED_LOCAL_AI_SKIP_PREPARE=1."
              fi
            '';
          };
        });
    };
}
