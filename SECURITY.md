# Security Policy

## Supported versions

Kaido is in early development. Security fixes are applied to the latest release only.

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public issues, discussions or pull requests.

Instead, use GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/carlosdlf/kaido-app/security/advisories/new).

Please include:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- The Kaido version and your operating system

You can expect an acknowledgement within a few days. We will keep you updated while we work on a fix and credit you in the release notes unless you prefer otherwise.

## Scope

Kaido stores notes in a git repository on your machine and runs the system `git` to sync them. Issues of particular interest include anything that could leak note contents, run unintended commands, or expose credentials.
