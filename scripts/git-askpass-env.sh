#!/bin/sh
# GIT_ASKPASS for the engine's Gitea remotes (src/git/gitea.ts giteaGitEnv).
#
# git calls this once per credential prompt with the prompt text as $1:
#   "Username for 'http://gitea.corp:3000': "          -> oauth2
#   "Password for 'http://oauth2@gitea.corp:3000': "   -> the token
# The token only ever travels in the environment (GITEA_TOKEN from the systemd env file):
# never on a command line, never written into .git/config, never printed by the engine.
case "$1" in
  [Uu]sername*) printf '%s\n' 'oauth2' ;;
  *) printf '%s\n' "${GITEA_TOKEN:-}" ;;
esac
