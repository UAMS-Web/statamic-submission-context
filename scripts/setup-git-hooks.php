<?php

/**
 * Point git at the committed `.githooks/` directory so the pre-commit gates are
 * active in every clone, without each developer running the config command by hand.
 *
 * Invoked from composer `post-install-cmd` / `post-update-cmd`. It is a no-op
 * outside a git work tree (a dist install, for example) so composer never fails
 * on a checkout that has no `.git`.
 */

declare(strict_types=1);

exec('git rev-parse --is-inside-work-tree 2>&1', $output, $exitCode);

if ($exitCode !== 0 || trim(implode('', $output)) !== 'true') {
    return;
}

// Idempotent, so it is safe to run on every install and update.
exec('git config core.hooksPath .githooks', $configOutput, $configExit);

if ($configExit === 0) {
    echo "Git hooks installed (core.hooksPath -> .githooks).\n";

    return;
}

fwrite(STDERR, "Warning: could not set core.hooksPath; run 'git config core.hooksPath .githooks' manually.\n");
