# Key-scope abuse attempts · pause.caesura.testnet

| attempt | outcome | what was said |
|---|---|---|
| proposer key calls assay | **refused** | Access key does not allow method assay |
| assayer key calls propose | **refused** | Access key does not allow method propose |
| proposer key transfers 1 yocto | **refused** | Access key requires full access |
| assayer key calls set_policy | **refused** | Access key does not allow method set_policy |
| outside account calls propose | **refused** | Access key ed25519:HW3Jze8vY5J3CndiF9k3ty4e8EcueqAEhkdVwnBQ2Rtr does not exist at block height 276938573 |
