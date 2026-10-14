<?php

declare(strict_types=1);

namespace UAMSWeb\AddonTemplate\Tests\Feature;

use Statamic\Facades\Addon;
use Tests\TestCase;
use UAMSWeb\AddonTemplate\ServiceProvider;

/**
 * Host-bound smoke test: the add-on is discovered and booted by a real Statamic
 * host.
 *
 * This class extends the HOST application's `Tests\TestCase`, which does not
 * exist in this package, so it cannot run in the standalone gate (`composer ci`
 * has no `Feature` suite and static analysis excludes this directory). It runs
 * from the root of the host described in `docs/DEVELOPMENT.md`, with the add-on
 * installed through a path repository.
 *
 * @command  php artisan test vendor/uams-web/statamic-addon-template/tests/Feature/HostRegistersAddonTest.php
 */
final class HostRegistersAddonTest extends TestCase
{
    /**
     * The host discovered the package through `extra.statamic` and lists it as
     * an add-on.
     */
    public function test_the_host_lists_the_addon(): void
    {
        // Collect the package name of every add-on the host discovered
        $packages = Addon::all()->map->package()->all();

        // Expect this add-on among them
        $this->assertContains('uams-web/statamic-addon-template', $packages);
    }

    /** The add-on's service provider was registered and booted by the host. */
    public function test_the_host_registers_the_service_provider(): void
    {
        $this->assertInstanceOf(ServiceProvider::class, $this->app->getProvider(ServiceProvider::class));
    }
}
