#!/usr/bin/env node
/* eslint no-console:0, no-var:0 */
const Liftoff = require('liftoff');
const interpret = require('interpret');
const path = require('path');
const tildify = require('tildify');
const commander = require('commander');
const color = require('colorette');
const argv = require('getopts')(process.argv.slice(2));
const fs = require('fs');
const { promisify } = require('util');
const cliPkg = require('../package');
const {
  mkConfigObj,
  resolveEnvironmentConfig,
  exit,
  success,
  checkLocalModule,
  getMigrationExtension,
  getSeedExtension,
  getStubPath,
} = require('./utils/cli-config-utils');

const { listMigrations } = require('./utils/migrationsLister');

const fsPromised = {
  readFile: promisify(fs.readFile),
  writeFile: promisify(fs.writeFile),
};

function initKnex(env, opts) {
  if (opts.esm) {
    // enable esm interop via 'esm' module
    require = require('esm')(module);
  }

  env.configuration = env.configPath
    ? require(env.configPath)
    : mkConfigObj(opts);

  // FYI: By default, the extension for the migration files is inferred
  //      from the knexfile's extension. So, the following lines are in
  //      place for backwards compatibility purposes.
  if (!env.configuration.ext) {
    const p = env.configPath || opts.knexpath;

    // TODO: Should this property be documented somewhere?
    env.configuration.ext = path.extname(p).replace('.', '');
  }

  checkLocalModule(env);
  if (process.cwd() !== env.cwd) {
    process.chdir(env.cwd);
    console.log(
      'Working directory changed to',
      color.magenta(tildify(env.cwd))
    );
  }

  const resolvedConfig = resolveEnvironmentConfig(opts, env.configuration);
  const knex = require(env.modulePath);
  return knex(resolvedConfig);
}

function invoke(env) {
  env.modulePath = env.modulePath || env.knexpath || process.env.KNEX_PATH;

  const filetypes = ['js', 'coffee', 'ts', 'eg', 'ls'];
  let pending = null;

  const cliVersion = [
    color.blue('Knex CLI version:'),
    color.green(cliPkg.version),
  ].join(' ');

  const localVersion = [
    color.blue('Knex Local version:'),
    color.green(env.modulePackage.version || 'None'),
  ].join(' ');

  commander
    .version(`${cliVersion}\n${localVersion}`)
    .option('--debug', 'Run with debugging.')
    .option('--knexfile [path]', 'Specify the knexfile path.')
    .option('--knexpath [path]', 'Specify the path to knex instance.')
    .option('--cwd [path]', 'Specify the working directory.')
    .option('--client [name]', 'Set DB client without a knexfile.')
    .option('--connection [address]', 'Set DB connection without a knexfile.')
    .option(
      '--migrations-directory [path]',
      'Set migrations directory without a knexfile.'
    )
    .option(
      '--migrations-table-name [path]',
      'Set migrations table name without a knexfile.'
    )
    .option(
      '--env [name]',
      'environment, default: process.env.NODE_ENV || development'
    )
    .option('--esm', 'Enable ESM interop.');

  commander
    .command('init')
    .description('        Create a fresh knexfile.')
    .option(
      `-x [${filetypes.join('|')}]`,
      'Specify the knexfile extension (default js)'
    )
    .action(() => {
      const type = (argv.x || 'js').toLowerCase();
      if (filetypes.indexOf(type) === -1) {
        exit(`Invalid filetype specified: ${type}`);
      }
      if (env.configuration) {
        exit(`Error: ${env.knexfile} already exists`);
      }
      checkLocalModule(env);
      const stubPath = `./knexfile.${type}`;
      pending = fsPromised
        .readFile(
          path.dirname(env.modulePath) +
            '/lib/migrate/stub/knexfile-' +
            type +
            '.stub'
        )
        .then((code) => {
          return fsPromised.writeFile(stubPath, code);
        })
        .then(() => {
          success(color.green(`Created ${stubPath}`));
        })
        .catch(exit);
    });

  commander
    .command('migrate:make <name>')
    .description('        Create a named migration file.')
    .option(
      `-x [${filetypes.join('|')}]`,
      'Specify the stub extension (default js)'
    )
    .option(
      `--stub [<relative/path/from/knexfile>|<name>]`,
      'Specify the migration stub to use. If using <name> the file must be located in config.migrations.directory'
    )
    .action((name) => {
      const opts = commander.opts();
      opts.client = opts.client || 'sqlite3'; // We don't really care about client when creating migrations
      const instance = initKnex(env, opts);
      const ext = getMigrationExtension(env, opts);
      const configOverrides = { extension: ext };

      const stub = getStubPath('migrations', env, opts);
      if (stub) {
        configOverrides.stub = stub;
      }

      pending = instance.migrate
        .make(name, configOverrides)
        .then((name) => {
          success(color.green(`Created Migration: ${name}`));
        })
        .catch(exit);
    });

  commander
    .command('migrate:latest')
    .description('        Run all migrations that have not yet been run.')
    .option('--verbose', 'verbose')
    .action(() => {
      pending = initKnex(env, commander.opts())
        .migrate.latest()
        .then(([batchNo, log]) => {
          if (log.length === 0) {
            success(color.cyan('Already up to date'));
          }
          success(
            color.green(`Batch ${batchNo} run: ${log.length} migrations`) +
              (argv.verbose ? `\n${color.cyan(log.join('\n'))}` : '')
          );
        })
        .catch(exit);
    });

  commander
    .command('migrate:up [<name>]')
    .description(
      '        Run the next or the specified migration that has not yet been run.'
    )
    .action((name) => {
      pending = initKnex(env, commander.opts())
        .migrate.up({ name })
        .then(([batchNo, log]) => {
          if (log.length === 0) {
            success(color.cyan('Already up to date'));
          }

          success(
            color.green(
              `Batch ${batchNo} ran the following migrations:\n${log.join(
                '\n'
              )}`
            )
          );
        })
        .catch(exit);
    });

  commander
    .command('migrate:rollback')
    .description('        Rollback the last batch of migrations performed.')
    .option('--all', 'rollback all completed migrations')
    .option('--verbose', 'verbose')
    .action((cmd) => {
      const { all } = cmd;

      pending = initKnex(env, commander.opts())
        .migrate.rollback(null, all)
        .then(([batchNo, log]) => {
          if (log.length === 0) {
            success(color.cyan('Already at the base migration'));
          }
          success(
            color.green(
              `Batch ${batchNo} rolled back: ${log.length} migrations`
            ) + (argv.verbose ? `\n${color.cyan(log.join('\n'))}` : '')
          );
        })
        .catch(exit);
    });

  commander
    .command('migrate:down [<name>]')
    .description(
      '        Undo the last or the specified migration that was already run.'
    )
    .action((name) => {
      pending = initKnex(env, commander.opts())
        .migrate.down({ name })
        .then(([batchNo, log]) => {
          if (log.length === 0) {
            success(color.cyan('Already at the base migration'));
          }

          success(
            color.green(
              `Batch ${batchNo} rolled back the following migrations:\n${log.join(
                '\n'
              )}`
            )
          );
        })
        .catch(exit);
    });

  commander
    .command('migrate:currentVersion')
    .description('        View the current version for the migration.')
    .action(() => {
      pending = initKnex(env, commander.opts())
        .migrate.currentVersion()
        .then((version) => {
          success(color.green('Current Version: ') + color.blue(version));
        })
        .catch(exit);
    });

  commander
    .command('migrate:list')
    .alias('migrate:status')
    .description('        List all migrations files with status.')
    .action(() => {
      pending = initKnex(env, commander.opts())
        .migrate.list()
        .then(([completed, newMigrations]) => {
          listMigrations(completed, newMigrations);
        })
        .catch(exit);
    });

  commander
    .command('seed:make <name>')
    .description('        Create a named seed file.')
    .option(
      `-x [${filetypes.join('|')}]`,
      'Specify the stub extension (default js)'
    )
    .option(
      `--stub [<relative/path/from/knexfile>|<name>]`,
      'Specify the seed stub to use. If using <name> the file must be located in config.seeds.directory'
    )
    .action((name) => {
      const opts = commander.opts();
      opts.client = opts.client || 'sqlite3'; // We don't really care about client when creating seeds
      const instance = initKnex(env, opts);
      const ext = getSeedExtension(env, opts);
      const configOverrides = { extension: ext };
      const stub = getStubPath('seeds', env, opts);
      if (stub) {
        configOverrides.stub = stub;
      }

      pending = instance.seed
        .make(name, configOverrides)
        .then((name) => {
          success(color.green(`Created seed file: ${name}`));
        })
        .catch(exit);
    });

  commander
    .command('seed:run')
    .description('        Run seed files.')
    .option('--verbose', 'verbose')
    .option('--specific', 'run specific seed file')
    .action(() => {
      pending = initKnex(env, commander.opts())
        .seed.run({ specific: argv.specific })
        .then(([log]) => {
          if (log.length === 0) {
            success(color.cyan('No seed files exist'));
          }
          success(
            color.green(`Ran ${log.length} seed files`) +
              (argv.verbose ? `\n${color.cyan(log.join('\n'))}` : '')
          );
        })
        .catch(exit);
    });

  if (!process.argv.slice(2).length) {
    commander.outputHelp();
  }

  commander.parse(process.argv);
}

const cli = new Liftoff({
  name: 'knex',
  extensions: interpret.jsVariants,
  v8flags: require('v8flags'),
  moduleName: require('../package.json').name,
});

cli.on('require', function(name) {
  console.log('Requiring external module', color.magenta(name));
});

cli.on('requireFail', function(name) {
  console.log(color.red('Failed to load external module'), color.magenta(name));
});

// FYI: The handling for the `--cwd` and `--knexfile` arguments is a bit strange,
//      but we decided to retain the behavior for backwards-compatibility.  In
//      particular: if `--knexfile` is a relative path, then it will be resolved
//      relative to `--cwd` instead of the shell's CWD.
//
//      So, the easiest way to replicate this behavior is to have the CLI change
//      its CWD to `--cwd` immediately before initializing everything else.  This
//      ensures that Liftoff will then resolve the path to `--knexfile` correctly.
if (argv.cwd) {
  process.chdir(argv.cwd);
}

cli.launch(
  {
    configPath: argv.knexfile,
    require: argv.require,
    completion: argv.completion,
  },
  invoke
);
