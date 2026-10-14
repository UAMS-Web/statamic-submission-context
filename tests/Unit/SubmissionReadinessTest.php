<?php

declare(strict_types=1);

/**
 * `composer.json` carries every field the submission checklist lists as a
 * prerequisite for a public package. The test fails when one is dropped; it does
 * not submit anything.
 *
 * `license` is not in the list yet: add it to the field list below in the same
 * change that adds it to `composer.json`, once UAMS legal has decided
 * (UAMS-Web/uams-statamic#3039).
 *
 * @command  vendor/bin/pest tests/Unit/SubmissionReadinessTest.php
 */

/**
 * The parsed `composer.json`.
 *
 * @return array<string, mixed> The manifest's top-level fields by name.
 */
function submissionManifest(): array
{
    /** @var array<string, mixed> */
    return json_decode((string) file_get_contents(dirname(__DIR__, 2).'/composer.json'), true, flags: JSON_THROW_ON_ERROR);
}

it('declares every top-level field a public package needs', function (string $field): void {
    // Expect the field present and filled in
    expect(submissionManifest())->toHaveKey($field);
    expect(submissionManifest()[$field])->not->toBeEmpty();
})->with(['name', 'description', 'keywords', 'type', 'authors', 'support', 'autoload']);

it('is a statamic-addon under the uams-web vendor', function (): void {
    // Read the manifest
    $manifest = submissionManifest();

    // Expect the add-on type and the uams-web vendor
    expect($manifest['type'])->toBe('statamic-addon')
        ->and($manifest['name'])->toStartWith('uams-web/');
});

it('names and describes itself for the Control Panel', function (): void {
    // Read the manifest's extra section
    /** @var array{statamic?: array{name?: string, description?: string}, laravel?: array{providers?: list<string>}} $extra */
    $extra = submissionManifest()['extra'];

    // Expect a name, a description and a discovered provider
    expect($extra['statamic']['name'] ?? '')->not->toBeEmpty()
        ->and($extra['statamic']['description'] ?? '')->not->toBeEmpty()
        ->and($extra['laravel']['providers'] ?? [])->not->toBeEmpty();
});

it('ships the checklist the readiness fields come from', function (): void {
    expect(dirname(__DIR__, 2).'/docs/SUBMISSION.md')->toBeFile();
});
