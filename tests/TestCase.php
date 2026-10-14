<?php

declare(strict_types=1);

namespace UAMSWeb\AddonTemplate\Tests;

use Illuminate\Foundation\Application;
use Statamic\Testing\AddonTestCase;
use UAMSWeb\AddonTemplate\ServiceProvider;

/**
 * Base class for the Integration suite: boots a minimal Statamic through
 * Orchestra Testbench with this add-on's provider registered.
 */
abstract class TestCase extends AddonTestCase
{
    /**
     * The add-on provider Statamic's test case registers before each test.
     *
     * @var string Class name of this add-on's service provider.
     */
    protected string $addonServiceProvider = ServiceProvider::class;

    /**
     * Give each parallel worker its own service manifest before the application
     * boots.
     *
     * Every worker boots the same Testbench skeleton, whose
     * `bootstrap/cache/services.php` each one rewrites when it is missing or
     * stale. On Windows, replacing a file another process has open fails with
     * "Access is denied", failing whichever test was booting (#88). Testbench
     * already names the package manifest per worker
     * (`test_{token}_packages.php`); this does the same for the service
     * manifest. The path is relative, so it resolves against the skeleton:
     * Laravel treats a Windows drive path as relative too.
     */
    protected function setUp(): void
    {
        // Read the parallel worker token, if this is a parallel run
        $token = $_SERVER['TEST_TOKEN'] ?? null;
        // Name a service manifest for this worker when there is a token
        if (is_string($token) || is_int($token)) {
            $_SERVER['APP_SERVICES_CACHE'] = $_ENV['APP_SERVICES_CACHE'] = "bootstrap/cache/test_{$token}_services.php";
        }

        // Boot the application
        parent::setUp();
    }

    /**
     * Give each parallel worker its own license-check cache, after Statamic's
     * test case sets the shared one.
     *
     * Every authenticated Control Panel page asks Statamic's license check, which
     * takes a file lock in the `outpost` cache store. Statamic's `AddonTestCase`
     * points that store at one directory for every worker, so on Windows a worker
     * opening the lock file while another holds it fails with "Permission denied",
     * failing whichever test was rendering a page (#126). A directory per worker
     * keeps the lock and the cached response apart, and still keeps the response
     * between tests, so the check does not reach the network on every test.
     *
     * Statamic sets the store here rather than in `defineEnvironment()`, which runs
     * first, so the override must follow the parent call.
     *
     * @param  Application  $app  The application being configured.
     */
    #[\Override]
    protected function getEnvironmentSetUp($app): void
    {
        // Let Statamic's test case configure the environment first
        parent::getEnvironmentSetUp($app);

        // Point the license-check cache at this worker's directory, if any
        $path = self::outpostCachePath($_SERVER['TEST_TOKEN'] ?? null);
        if ($path !== null) {
            $app['config']->set('cache.stores.outpost.path', $path);
        }
    }

    /**
     * The license-check cache directory for a parallel worker token, or null
     * outside a parallel run.
     *
     * @param  mixed  $token  The parallel worker token, or null outside a parallel run.
     * @return ?string The worker's cache directory, or null without a usable token.
     */
    public static function outpostCachePath(mixed $token): ?string
    {
        return is_string($token) || is_int($token) ? storage_path("framework/cache/outpost-data-{$token}") : null;
    }

    /**
     * Give the application an encryption key, which a Control Panel request
     * needs for its session, and register the REST and GraphQL routes.
     *
     * @param  Application  $app  The application being configured.
     */
    protected function defineEnvironment($app): void
    {
        // Set an encryption key for the session
        $app['config']->set('app.key', 'base64:'.base64_encode(str_repeat('k', 32)));

        // Statamic registers the REST and GraphQL routes while booting, and only when
        // enabled, so they are enabled here; which resources they expose, and the Pro
        // edition they require, are read per request and left to each test.
        $app['config']->set('statamic.api.enabled', true);
        $app['config']->set('statamic.graphql.enabled', true);
    }
}
