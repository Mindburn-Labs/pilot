terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

variable "do_token" {
  description = "DigitalOcean API Token"
  type        = string
  sensitive   = true
}

variable "spaces_access_key" {
  description = "Spaces Access Key for bucket management"
  type        = string
}

variable "spaces_secret_key" {
  description = "Spaces Secret Key for bucket management"
  type        = string
  sensitive   = true
}

variable "ssh_key_name" {
  description = "Name of the SSH key on DigitalOcean"
  type        = string
  default     = "helm-deploy"
}

provider "digitalocean" {
  token             = var.do_token
  spaces_access_id  = var.spaces_access_key
  spaces_secret_key = var.spaces_secret_key
}

data "digitalocean_ssh_key" "deploy" {
  name = "helm-deploy"
}

data "digitalocean_ssh_key" "ivan" {
  name = "ivan-local-ed25519"
}

resource "digitalocean_droplet" "pilot_prod" {
  image    = "ubuntu-22-04-x64"
  name     = "helm-pilot-prod"
  region   = "fra1"
  size     = "s-2vcpu-4gb"
  tags     = ["helm-pilot", "production"]
  ssh_keys = [data.digitalocean_ssh_key.deploy.id, data.digitalocean_ssh_key.ivan.id]

  lifecycle {
    ignore_changes = [image]
  }
}

resource "digitalocean_firewall" "pilot_fw" {
  name = "helm-pilot-prod-fw"

  droplet_ids = [digitalocean_droplet.pilot_prod.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

# --- Backup Storage ---

resource "digitalocean_spaces_bucket" "backups" {
  name   = "helm-pilot-prod-backups"
  region = "fra1"

  lifecycle_rule {
    enabled = true

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      days = 7
    }

    abort_incomplete_multipart_upload_days = 3
  }
}
