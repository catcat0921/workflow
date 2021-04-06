const inquirer = require('inquirer')
const EventEmitter = require('events')
const Generator = require('./Generator')
const cloneDeep = require('lodash.clonedeep')
const PackageManager = require('./util/ProjectPackageManager')
const { clearConsole } = require('./util/clearConsole')
const PromptModuleAPI = require('./PromptModuleAPI')
const writeFileTree = require('./util/writeFileTree')
const loadRemotePreset = require('./util/loadRemotePreset')
const generateReadme = require('./util/generateReadme')

const {
  defaults,
  loadOptions,
  validatePreset
} = require('./options')

const {
  chalk,
  execa,
  log,
  warn,
  error,
  logWithSpinner,
  stopSpinner,
  hasGit,
  hasYarn,
  hasPnpm3OrLater,
  exit,
  loadModule
} = require('@pkb/shared-utils')

module.exports = class Creator extends EventEmitter {
  constructor (name, context, promptModules) {
    super()

    this.name = name
    this.context = process.env.VUE_CLI_CONTEXT = context
    const { presetPrompt, featurePrompt } = this.resolveIntroPrompts()
    this.presetPrompt = presetPrompt
    this.featurePrompt = featurePrompt
    this.outroPrompts = this.resolveOutroPrompts()
    this.injectedPrompts = []
    this.promptCompleteCbs = []
    this.afterInvokeCbs = []
    this.afterAnyInvokeCbs = []

    this.run = this.run.bind(this)

    const promptAPI = new PromptModuleAPI(this)
    promptModules.forEach(m => m(promptAPI))
  }

  async create (cliOptions = {}, preset = null) {
    const isTestOrDebug = process.env.VUE_CLI_TEST || process.env.VUE_CLI_DEBUG
    const { run, name, context, afterInvokeCbs, afterAnyInvokeCbs } = this

    if (!preset) {
      preset = await this.promptAndResolvePreset()
    }

    preset = cloneDeep(preset)

    const packageManager = (
      cliOptions.packageManager ||
      loadOptions().packageManager ||
      (hasYarn() ? 'yarn' : null) ||
      (hasPnpm3OrLater() ? 'pnpm' : 'npm')
    )

    const pm = new PackageManager({ context, forcePackageManager: packageManager })

    await clearConsole()
    logWithSpinner('✨', `创建项目 in ${chalk.yellow(context)}.`)

    const pkg = {
      name,
      version: '0.1.0',
      private: true,
      devDependencies: {}
    }

    // todo 安装插件
    const deps = Object.keys(preset.plugins)

    await writeFileTree(context, {
      'package.json': JSON.stringify(pkg, null, 2)
    })

    const shouldInitGit = this.shouldInitGit(cliOptions)
    if (shouldInitGit) {
      logWithSpinner('🗃', '正在初始化 git ...')
      this.emit('creation', { event: 'git-init' })
      await run('git init')
    }

    stopSpinner()
    log('⚙  初始化插件. 可能需要等一会...')
    log()
    this.emit('creation', { event: 'plugins-install' })

    // run generator
    log('🚀  创建中...')
    const plugins = await this.resolvePlugins(preset.plugins)
    const generator = new Generator(context, {
      pkg,
      plugins,
      afterInvokeCbs,
      afterAnyInvokeCbs
    })

    // install additional deps (injected by generators)
    log('📦  安装依赖中...')
    log()
    if (!isTestOrDebug) {
      await pm.install()
    }

    // run complete cbs if any (injected by generators)
    logWithSpinner('⚓', '运行完成 hooks...')
    for (const cb of afterInvokeCbs) {
      await cb()
    }
    for (const cb of afterAnyInvokeCbs) {
      await cb()
    }

    // generate README.md
    stopSpinner()
    log()
    logWithSpinner('📄', '创建 README.md...')
    await writeFileTree(context, {
      'README.md': generateReadme(generator.pkg, packageManager)
    })

    let gitCommitFailed = false
    if (shouldInitGit) {
      await run('git add -A')
      try {
        await run('git', ['commit', '-m', 'init'])
      } catch (e) {
        gitCommitFailed = true
      }
    }

    stopSpinner()
    log()
    log(`🎉  成功创建项目 ${chalk.yellow(name)}.`)
    log()

    if (gitCommitFailed) {
      warn(
        '由于git配置中缺少用户名和电子邮件，所以跳过了git提交.\n' +
        '您需要自己执行初始提交.\n'
      )
    }

    generator.printExitLogs()
  }

  run (command, args) {
    if (!args) { [command, ...args] = command.split(/\s+/) }
    return execa(command, args, { cwd: this.context })
  }

  async promptAndResolvePreset (answers = null) {
    if (!answers) {
      await clearConsole(true)
      answers = await inquirer.prompt(this.resolveFinalPrompts())
    }

    const preset = await this.resolvePreset(answers.preset)

    validatePreset(preset)

    return preset
  }

  async resolvePreset (name, clone) {
    let preset
    const savedPresets = loadOptions().presets || {}

    console.log(name, preset, savedPresets)

    if (name in savedPresets) {
      preset = savedPresets[name]
    } else if (name.includes('/')) {
      logWithSpinner(`Fetching remote preset ${chalk.cyan(name)}...`)
      try {
        preset = await loadRemotePreset(name, clone)
        stopSpinner()
      } catch (e) {
        stopSpinner()
        error(`Failed fetching remote preset ${chalk.cyan(name)}:`)
        throw e
      }
    }

    // if (!preset) {
    //   error(`preset "${name}" not found.`)
    //   const presets = Object.keys(savedPresets)
    //   if (presets.length) {
    //     log()
    //     log(`available presets:\n${presets.join('\n')}`)
    //   } else {
    //     log('you don\'t seem to have any saved preset.')
    //   }
    //   exit(1)
    // }

    return preset
  }

  async resolvePlugins (rawPlugins) {
    const plugins = []
    for (const id of Object.keys(rawPlugins)) {
      const apply = loadModule(`${id}/generator`, this.context) || (() => {})
      let options = rawPlugins[id] || {}
      if (options.prompts) {
        const prompts = loadModule(`${id}/prompts`, this.context)
        if (prompts) {
          log()
          log(`${chalk.cyan(options._isPreset ? 'Preset options:' : id)}`)
          options = await inquirer.prompt(prompts)
        }
      }
      plugins.push({ id, apply, options })
    }
    return plugins
  }

  getPresets () {
    const savedOptions = loadOptions()
    return Object.assign({}, savedOptions.presets, defaults.presets)
  }

  resolveIntroPrompts () {
    const presetPrompt = {
      name: 'preset',
      type: 'list',
      message: '您要创建的项目是哪种类型:',
      choices: [
        {
          name: 'webpack',
          value: 'webpack',
          message: '大型框架[使用 webpack 打包]'
        },
        {
          name: 'rollup',
          value: 'rollup',
          message: '小型库[使用 rollup 打包]'
        },
        {
          name: 'vite',
          value: 'vite',
          message: '快速编译[使用 vite 打包]'
        }
      ]
    }

    const featurePrompt = {
      name: 'features',
      type: 'checkbox',
      message: '检查项目所需的特性',
      choices: [],
      pageSize: 10
    }

    return {
      presetPrompt,
      featurePrompt
    }
  }

  resolveOutroPrompts () {
    const outroPrompts = []

    const savedOptions = loadOptions()
    if (!savedOptions.packageManager && (hasYarn() || hasPnpm3OrLater())) {
      const packageManagerChoices = []

      if (hasYarn()) {
        packageManagerChoices.push({
          name: 'Use Yarn',
          value: 'yarn',
          short: 'Yarn'
        })
      }

      if (hasPnpm3OrLater()) {
        packageManagerChoices.push({
          name: 'Use PNPM',
          value: 'pnpm',
          short: 'PNPM'
        })
      }

      packageManagerChoices.push({
        name: 'Use NPM',
        value: 'npm',
        short: 'NPM'
      })

      outroPrompts.push({
        name: 'packageManager',
        type: 'list',
        message: 'Pick the package manager to use when installing dependencies:',
        choices: packageManagerChoices
      })
    }

    return outroPrompts
  }

  resolveFinalPrompts () {
    const prompts = [
      this.presetPrompt,
      this.featurePrompt,
      ...this.injectedPrompts,
      ...this.outroPrompts
    ]
    return prompts
  }

  shouldInitGit () {
    if (!hasGit()) {
      return false
    }
    return true
  }
}
