data "external_schema" "sequelize" {
  program = ["npx", "@ariga/atlas-provider-sequelize", "load", "--path", "./models", "--dialect", "mariadb"]
}

variable "scratch_url" {
  type = string
}

env "benchmark" {
  src = data.external_schema.sequelize.url
  dev = var.scratch_url
  migration {
    dir = "file://migrations"
  }
}
