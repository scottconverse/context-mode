# Cost Hygiene

This repository uses conservative GitHub resource defaults:

- Keep CI artifacts short-lived unless they are release deliverables.
- Put final downloadable outputs in Releases, not long-lived Actions artifacts.
- Use GitHub Packages only for real packages or container images, not as artifact overflow.
- Prefer `concurrency.cancel-in-progress: true` for push and pull request workflows.
- Keep expensive jobs manual, path-filtered, or limited to meaningful changes.
- Keep multi-OS CI public where appropriate; private Windows/macOS jobs are more cost-sensitive.
- Do not use Codespaces as a CI substitute.
- Use the manual `Cost Hygiene Check` workflow before cleanup so nothing important is deleted by accident.
