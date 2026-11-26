-- Where an agent's runs execute their shell and file tools.
--   machine_kind: null is the default (the gateway's own machine when the deploy allows it, else
--     none); 'none' is no machine; 'gateway' is the gateway's own; 'machine' is one connected
--     machine of the workspace, named by machine_id.
-- machine_id has no foreign key on purpose: a machine that is removed leaves the choice behind,
-- and a run that meets it says the machine is gone instead of silently going elsewhere.
ALTER TABLE agent_config
    ADD COLUMN machine_kind text CHECK (machine_kind IN ('none', 'gateway', 'machine')),
    ADD COLUMN machine_id text,
    ADD CONSTRAINT agent_config_machine_shape CHECK (
        COALESCE(machine_kind = 'machine', false) = (machine_id IS NOT NULL)
    );
