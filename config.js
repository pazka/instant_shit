fs = require('fs')

const envVarRegex = '^\$\{(.*)\}$'

/**
 *
 Standalone config management util.
 It will read a specified JSON config file (or created it if it doesn't exist)
 and parse any value that is written like ${ENV_VAR_NAME} with it's os equivalent

 There basic config is as follow :
 {
        "ENV" : "DEV",
        "DEV":{}
    }

 * @type {{}}
 */
let config = {}
let configName = "NONE"

/**
 *
 Read and search for the ENV key in the config file(json) to set the current config

 @param configPath: config path to read or create the config at
 @return: the current parsed config
 */
function initConfig(configPath) {
    let fullConfig = {}

    // Creating default file
    if (fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, '{"ENV" : "DEV","DEV":{}}')
    }

    // Opening default file
    const data = fs.readFileSync(configPath)
    fullConfig = JSON.parse(data)

    function __tryParseEnvVarFromConfig(varName) {
        /**
         *
         Will parse every value that written like "${SOME_VALUE}"
         with the value stored in the environment variable named SOME_VALUE

         If the envvar dosen't exist, it raises an error
         */
        if (varName.match(envVarRegex)) {
            const envVarName = varName.search(envVarRegex)[0]
            try {
                return process.env[envVarName]
            } catch (e) {
                throw new Error(`The env var ${envVarName} has not been found`)
            }
        } else {
            return varName
        }
    }

    function __recursParceEnvVar(config) {
        Object.entries(config).forEach(([key, val]) => {
            if (typeof val === "object") {
                config[key] = __recursParceEnvVar(val)
            } else if (typeof val === "string") {
                config[key] = __tryParseEnvVarFromConfig(val)
            }
        })

        return config
    }

    // Parce Env vars
    fullConfig = __recursParceEnvVar(fullConfig)

    if (!Object.keys(fullConfig).includes("ENV")) {
        throw new SyntaxError("The 'ENV' key is not present in the config file. Unable to set the current environment")
    }

    if (!Object.keys(fullConfig).includes(fullConfig["ENV"])) {
        console.error('Unable to set the current environment')
        throw new SyntaxError(`The ${fullConfig["ENV"]} key is not present in the config.json. `)
    }

    configName = __tryParseEnvVarFromConfig(fullConfig["ENV"])
    config = fullConfig[fullConfig["ENV"]]
    return config
}

/**
 *     @param key: optional, key to search, in the format "key.key2.key3" for nested props
 @return: The whole config if no key was specified, the value otherwise
 */
function getConfig(key = "") {
    if (key.strip("") !== "" && !key.match('(\\w\\.?)*')) {
        throw new Error("The key must be in the format key1.key2.key3...")
    }

    let val = config
    key.split('.').forEach(subKey => {
        if (subKey === "")
            return
        try {
            val = val[subKey]
        } catch (e) {
            throw new RangeError(`The key ${key} wasn't found in the config ${configName}`)
        }
    })
}

module.exports = (path = "config.json") => initConfig(path)