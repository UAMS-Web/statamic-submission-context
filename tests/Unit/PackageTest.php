<?php

declare(strict_types=1);

use UAMSWeb\AddonTemplate\ServiceProvider;

/**
 * `composer.json` registers the add-on's service provider for Laravel package
 * discovery, which is how a host application boots it.
 *
 * @command  vendor/bin/pest tests/Unit/PackageTest.php
 */
it('lists its service provider in composer.json so the host discovers it', function (): void {
    // Read composer.json and confirm it was readable
    $contents = file_get_contents(__DIR__.'/../../composer.json');
    expect($contents)->toBeString();

    // Decode the manifest
    /** @var array{extra: array{laravel: array{providers: list<string>}}} $manifest */
    $manifest = json_decode((string) $contents, true, flags: JSON_THROW_ON_ERROR);

    // Expect the provider among the discovered providers
    expect($manifest['extra']['laravel']['providers'])->toContain(ServiceProvider::class);
});
