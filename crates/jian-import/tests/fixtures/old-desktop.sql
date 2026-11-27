--
-- PostgreSQL database dump
--


-- Dumped from database version 18.7
-- Dumped by pg_dump version 19.0

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: channel_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.channel_type AS ENUM (
    'api',
    'telegram',
    'whatsapp',
    'whatsapp-business',
    'email'
);


--
-- Name: connection_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.connection_status AS ENUM (
    'disconnected',
    'connecting',
    'qr',
    'connected',
    'error'
);


--
-- Name: contact_scope; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.contact_scope AS ENUM (
    'direct',
    'group'
);


--
-- Name: contact_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.contact_status AS ENUM (
    'pending',
    'approved',
    'blocked'
);


--
-- Name: delivery_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.delivery_status AS ENUM (
    'pending',
    'sending',
    'sent',
    'failed',
    'unknown'
);


--
-- Name: errand_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.errand_status AS ENUM (
    'waiting',
    'answered',
    'expired'
);


--
-- Name: inbox_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.inbox_status AS ENUM (
    'pending',
    'submitted',
    'discarded'
);


--
-- Name: message_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.message_role AS ENUM (
    'user',
    'assistant'
);


--
-- Name: provider_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.provider_kind AS ENUM (
    'openai',
    'anthropic',
    'google',
    'openrouter',
    'groq',
    'openai-compatible',
    'xai',
    'ollama'
);


--
-- Name: run_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.run_status AS ENUM (
    'queued',
    'running',
    'completed',
    'failed',
    'interrupted',
    'cancelled',
    'waiting'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: artifact_folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifact_folders (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifacts (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    run_id uuid NOT NULL,
    tool_name text NOT NULL,
    content text NOT NULL,
    bytes integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: channel_auth; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_auth (
    channel_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    chunks jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: channel_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_connections (
    channel_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    desired boolean NOT NULL,
    generation integer NOT NULL,
    fence integer,
    status public.connection_status NOT NULL,
    owner text,
    lease_until bigint,
    retry_at bigint,
    account_id text,
    session_saved_at timestamp with time zone,
    error text,
    qr jsonb,
    qr_expires_at bigint,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: channel_inbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_inbox (
    id text NOT NULL,
    profile_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    generation integer NOT NULL,
    message jsonb NOT NULL,
    status public.inbox_status NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channels (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    type public.channel_type NOT NULL,
    address text,
    webhook_token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    handle text,
    picture_synced text,
    allow_all_contacts boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    automation_paused_at timestamp with time zone,
    messages jsonb
);


--
-- Name: checkpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checkpoints (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    run_id uuid NOT NULL,
    data jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    scope public.contact_scope NOT NULL,
    chat_id text NOT NULL,
    actor_id text NOT NULL,
    title text,
    status public.contact_status NOT NULL,
    session_id uuid,
    held_message jsonb,
    held_message_id text,
    agent_turns integer DEFAULT 0 NOT NULL,
    seen jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    avatar text,
    avatar_checked_at timestamp with time zone,
    ai_enabled boolean DEFAULT true NOT NULL,
    ai_paused_at timestamp with time zone,
    can_approve boolean DEFAULT false NOT NULL,
    held_channel_message jsonb
);


--
-- Name: decision_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.decision_usage (
    day text NOT NULL,
    use text NOT NULL,
    requests integer DEFAULT 0 NOT NULL,
    cached integer DEFAULT 0 NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL
);


--
-- Name: deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deliveries (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    run_id uuid,
    chat_id text NOT NULL,
    notice text,
    status public.delivery_status NOT NULL,
    error text,
    remote_message_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    connection_generation integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    said_count integer DEFAULT 0 NOT NULL,
    media_id uuid,
    source_run_id uuid,
    reaction jsonb,
    email jsonb
);


--
-- Name: device_pairings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_pairings (
    code_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone
);


--
-- Name: devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devices (
    id uuid NOT NULL,
    name text NOT NULL,
    platform text NOT NULL,
    token_hash text NOT NULL,
    push_token text,
    previews boolean DEFAULT true NOT NULL,
    focused_session uuid,
    focused_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    revoked_at timestamp with time zone
);


--
-- Name: email_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_bindings (
    channel_id uuid NOT NULL,
    address text NOT NULL
);


--
-- Name: email_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_domains (
    id uuid CONSTRAINT email_windows_id_not_null NOT NULL,
    profile_id uuid CONSTRAINT email_windows_profile_id_not_null NOT NULL,
    channel_id uuid CONSTRAINT email_windows_channel_id_not_null NOT NULL,
    session_id uuid,
    domain text CONSTRAINT email_windows_domain_not_null NOT NULL,
    reason text CONSTRAINT email_windows_reason_not_null NOT NULL,
    expires_at timestamp with time zone CONSTRAINT email_windows_expires_at_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT email_windows_created_at_not_null NOT NULL
);


--
-- Name: email_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_log (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    direction text NOT NULL,
    address text NOT NULL,
    subject text NOT NULL,
    text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_threads (
    channel_id uuid NOT NULL,
    chat_id text NOT NULL,
    subject text NOT NULL,
    message_id text NOT NULL,
    "references" text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: errands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.errands (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    from_session_id uuid NOT NULL,
    question text NOT NULL,
    status public.errand_status NOT NULL,
    answer text,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    answer_request_key text
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id bigint NOT NULL,
    profile_id uuid NOT NULL,
    run_id uuid,
    type text NOT NULL,
    data jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.events_id_seq OWNED BY public.events.id;


--
-- Name: file_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_links (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    session_id uuid,
    token_hash text NOT NULL,
    path text NOT NULL,
    bytes bigint NOT NULL,
    modified_ms bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: gateway_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gateway_secrets (
    name text NOT NULL,
    envelope jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: gateway_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gateway_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: github_installation_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.github_installation_requests (
    github_user_id bigint NOT NULL,
    login text NOT NULL,
    return_origin text NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: github_installation_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.github_installation_states (
    hash text NOT NULL,
    return_origin text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    purpose text DEFAULT 'installation'::text NOT NULL
);


--
-- Name: github_installations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.github_installations (
    id uuid NOT NULL,
    installation_id bigint NOT NULL,
    account_id bigint NOT NULL,
    login text NOT NULL,
    type text NOT NULL,
    avatar_url text,
    connected_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: github_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.github_reviews (
    id uuid NOT NULL,
    repository text NOT NULL,
    number integer NOT NULL,
    head_sha text NOT NULL,
    profile_id uuid NOT NULL,
    session_id uuid NOT NULL,
    trigger text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leases (
    profile_id uuid NOT NULL,
    resource text NOT NULL,
    session_id uuid NOT NULL,
    fence bigint NOT NULL,
    expires_at bigint NOT NULL
);


--
-- Name: leases_fence_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.leases_fence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: leases_fence_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.leases_fence_seq OWNED BY public.leases.fence;


--
-- Name: mail; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mail (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    from_session_id uuid NOT NULL,
    to_session_id uuid NOT NULL,
    text text NOT NULL,
    request_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mcp_secret_moves; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_secret_moves (
    profile_id uuid NOT NULL,
    from_name text NOT NULL,
    to_name text NOT NULL
);


--
-- Name: mcp_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_servers (
    name text NOT NULL,
    server jsonb NOT NULL,
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: media_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_assets (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    session_id uuid,
    contact_id uuid,
    run_id uuid,
    source_key text NOT NULL,
    mime_type text NOT NULL,
    data text NOT NULL,
    bytes integer NOT NULL,
    voice boolean DEFAULT false NOT NULL,
    analysis text,
    held boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text
);


--
-- Name: memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memories (
    profile_id uuid NOT NULL,
    key text NOT NULL,
    content text NOT NULL,
    version integer NOT NULL,
    source_session_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: memory_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_links (
    profile_id uuid NOT NULL,
    a_key text NOT NULL,
    b_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_links_check CHECK ((a_key < b_key))
);


--
-- Name: memory_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_projects (
    profile_id uuid NOT NULL,
    memory_key text NOT NULL,
    project_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    session_id uuid NOT NULL,
    run_id uuid,
    role public.message_role NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    author_id text,
    author_name text,
    call jsonb,
    purpose text,
    reactions jsonb DEFAULT '[]'::jsonb NOT NULL,
    channel_message jsonb,
    seq bigint NOT NULL,
    request_key text,
    read_at timestamp with time zone
);


--
-- Name: messages_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.messages_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: messages_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.messages_seq_seq OWNED BY public.messages.seq;


--
-- Name: model_defaults; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_defaults (
    role text CONSTRAINT gateway_model_defaults_role_not_null NOT NULL,
    provider_id uuid,
    model_id text,
    reasoning_effort text,
    voice_name text,
    updated_at timestamp with time zone DEFAULT now() CONSTRAINT gateway_model_defaults_updated_at_not_null NOT NULL
);


--
-- Name: people; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.people (
    profile_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    actor_id text NOT NULL,
    display_name text,
    avatar text,
    avatar_checked_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: profile_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profile_revisions (
    profile_id uuid NOT NULL,
    version integer NOT NULL,
    document jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    name text NOT NULL,
    instructions text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    avatar text,
    model jsonb NOT NULL,
    identity jsonb NOT NULL,
    context_policy jsonb NOT NULL,
    version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    allow_shell boolean DEFAULT true NOT NULL
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    name text NOT NULL,
    repository_url text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    github_account_id uuid,
    github_repository_id bigint
);


--
-- Name: providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.providers (
    id uuid NOT NULL,
    name text NOT NULL,
    kind public.provider_kind NOT NULL,
    auth_mode text,
    api_key_env text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    credential text,
    base_url text,
    active boolean DEFAULT true NOT NULL,
    label text
);


--
-- Name: pull_watchers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pull_watchers (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    session_id uuid NOT NULL,
    owner text NOT NULL,
    repo text NOT NULL,
    number integer NOT NULL,
    status text NOT NULL,
    ended_reason text,
    state jsonb DEFAULT '{}'::jsonb NOT NULL,
    own_shas jsonb DEFAULT '[]'::jsonb NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    next_poll_at timestamp with time zone NOT NULL,
    failing_since timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: release_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.release_reads (
    scope text NOT NULL,
    version text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: remote_machines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.remote_machines (
    id uuid NOT NULL,
    name text NOT NULL,
    platform text NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    capabilities jsonb DEFAULT '[]'::jsonb NOT NULL,
    ui_state text DEFAULT 'unknown'::text NOT NULL,
    version text,
    system text
);


--
-- Name: remote_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.remote_tasks (
    id uuid NOT NULL,
    machine_id uuid NOT NULL,
    profile_id uuid,
    command text NOT NULL,
    cwd text,
    timeout_ms integer NOT NULL,
    status text NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    kind text DEFAULT 'shell'::text NOT NULL,
    payload jsonb
);


--
-- Name: runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runs (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    session_id uuid NOT NULL,
    profile_version integer NOT NULL,
    request_key text NOT NULL,
    input text NOT NULL,
    status public.run_status NOT NULL,
    output text,
    error text,
    usage jsonb,
    continuation_of uuid,
    model jsonb,
    model_selection jsonb,
    context_policy jsonb,
    call jsonb,
    group_turn jsonb,
    lease_owner text,
    lease_until bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    progress jsonb,
    steer text,
    commentary jsonb,
    relay_to uuid,
    subagent jsonb,
    subagent_reported_at timestamp with time zone,
    question jsonb,
    approval jsonb,
    action jsonb
);


--
-- Name: schedule_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_runs (
    id uuid NOT NULL,
    schedule_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    due_at timestamp with time zone NOT NULL,
    manual boolean DEFAULT false NOT NULL,
    run_id uuid,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedules (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    session_id uuid,
    name text NOT NULL,
    instruction text NOT NULL,
    at timestamp with time zone,
    cron text,
    time_zone text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    next_run_at timestamp with time zone,
    last_run_at timestamp with time zone,
    last_run_id uuid,
    last_error text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    model jsonb,
    CONSTRAINT schedules_check CHECK (((at IS NULL) <> (cron IS NULL)))
);


--
-- Name: secret_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.secret_agents (
    secret_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    granted_by_profile_id uuid,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: secret_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.secret_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    sites text[] DEFAULT '{}'::text[] NOT NULL,
    created_by_profile_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone
);


--
-- Name: secret_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.secret_fields (
    secret_id uuid NOT NULL,
    "position" integer NOT NULL,
    label text NOT NULL,
    env_name text NOT NULL,
    sensitive boolean NOT NULL,
    vault_key text NOT NULL
);


--
-- Name: secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.secrets (
    profile_id uuid NOT NULL,
    name text NOT NULL,
    envelope jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: session_artifact_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_artifact_versions (
    artifact_id uuid NOT NULL,
    version integer NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    author text DEFAULT 'agent'::text NOT NULL,
    edit_key text
);


--
-- Name: session_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_artifacts (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    session_id uuid NOT NULL,
    title text NOT NULL,
    type text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    visibility text DEFAULT 'private'::text NOT NULL,
    public_token text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    folder_id uuid,
    public_password text,
    project_id uuid
);


--
-- Name: session_loads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_loads (
    profile_id uuid NOT NULL,
    session_id uuid NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    loaded_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone NOT NULL,
    used_since_compaction boolean DEFAULT true NOT NULL
);


--
-- Name: session_worktrees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_worktrees (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    session_id uuid NOT NULL,
    name text NOT NULL,
    branch text NOT NULL,
    base text NOT NULL,
    source text NOT NULL,
    path text NOT NULL,
    place text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_at timestamp with time zone
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid NOT NULL,
    profile_id uuid NOT NULL,
    title text,
    channel text NOT NULL,
    peer_profile_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    summary text,
    summarized_up_to timestamp with time zone,
    scope text,
    model jsonb,
    ponytail_mode text DEFAULT 'full'::text NOT NULL,
    caveman_mode text DEFAULT 'off'::text NOT NULL,
    summarized_through_id uuid,
    objective jsonb,
    project_id uuid,
    remote_machine_id uuid,
    protection text DEFAULT 'ask'::text NOT NULL,
    read_at timestamp with time zone,
    pinned boolean DEFAULT false NOT NULL,
    last_client text,
    workspace jsonb,
    CONSTRAINT sessions_caveman_mode_check CHECK ((caveman_mode = ANY (ARRAY['lite'::text, 'full'::text, 'ultra'::text, 'off'::text]))),
    CONSTRAINT sessions_ponytail_mode_check CHECK ((ponytail_mode = ANY (ARRAY['lite'::text, 'full'::text, 'ultra'::text, 'off'::text]))),
    CONSTRAINT sessions_protection CHECK ((protection = ANY (ARRAY['ask'::text, 'auto'::text, 'full'::text])))
);


--
-- Name: skills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.skills (
    name text NOT NULL,
    description text NOT NULL,
    instructions text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    origin jsonb,
    written_by text,
    author_profile_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ssh_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ssh_keys (
    id uuid NOT NULL,
    name text NOT NULL,
    public_key text NOT NULL,
    fingerprint text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_snapshots (
    profile_id uuid NOT NULL,
    location text NOT NULL,
    path text NOT NULL,
    content jsonb NOT NULL,
    hash text NOT NULL,
    read_at timestamp with time zone NOT NULL
);


--
-- Name: x_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.x_accounts (
    id uuid NOT NULL,
    x_user_id text NOT NULL,
    handle text NOT NULL,
    name text NOT NULL,
    status text NOT NULL,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    connected_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: x_connect_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.x_connect_states (
    hash text NOT NULL,
    verifier text NOT NULL,
    return_to text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events ALTER COLUMN id SET DEFAULT nextval('public.events_id_seq'::regclass);


--
-- Name: leases fence; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leases ALTER COLUMN fence SET DEFAULT nextval('public.leases_fence_seq'::regclass);


--
-- Name: messages seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ALTER COLUMN seq SET DEFAULT nextval('public.messages_seq_seq'::regclass);


--
-- Data for Name: artifact_folders; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: artifacts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: channel_auth; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: channel_connections; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: channel_inbox; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: channels; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: checkpoints; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: contacts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: decision_usage; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: deliveries; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: device_pairings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: devices; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.devices VALUES ('33333333-3333-4333-8333-333333333333', 'Pixel', 'android', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', NULL, true, NULL, NULL, '2026-11-25 17:45:03.574+00', NULL, NULL);


--
-- Data for Name: email_bindings; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: email_domains; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: email_log; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: email_threads; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: errands; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: events; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: file_links; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: gateway_secrets; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.gateway_secrets VALUES ('provider:openai', '{"iv": "V1kOfr871yWHQwZ0", "tag": "zuMxj293F1KpCQI+urmkwQ==", "keyId": "local", "version": 1, "ciphertext": "2GfbALm4AoxWI+lBvy0pKRjUl1Uhiw=="}', '2026-11-25 17:45:03.577+00', '2026-11-25 17:45:03.577+00');
INSERT INTO public.gateway_secrets VALUES ('provider:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"iv": "JzRDJbjH1PmS+Dcp", "tag": "hWOjux7NgOIy2b/5CRulZw==", "keyId": "local", "version": 1, "ciphertext": "regmSZiSBHs/BzkFwO6/Szf5ejXVtx0="}', '2026-11-25 17:45:03.577+00', '2026-11-25 17:45:03.577+00');
INSERT INTO public.gateway_secrets VALUES ('provider:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '{"iv":"gAXT+ygh4oeiVO24","tag":"o9o36xnEu79haUdeXsI30g==","keyId":"local","version":1,"ciphertext":"o2uwF8FiW6jEe9IlEXmkYFYc7GsMAMms1uHtGhm/PvA30deQIEZ9b8zj4Kh2dy+ZxS5Fw8aETv8TD286xTkHL2+4Tj/Voit1iRWp4ncGT8RtfZfAAUGo"}', '2026-11-25 17:45:03.577+00', '2026-11-25 17:45:03.577+00');
INSERT INTO public.gateway_secrets VALUES ('provider:cccccccc-cccc-4ccc-8ccc-cccccccccccc', '{"iv":"EPh9iIUzDDk7UWqb","tag":"MnxKsYaQuNmZwBwHuefDzA==","keyId":"local","version":1,"ciphertext":"jOfvRoxBcW0Rh7xJuVHookGTsUJNdDDa9+Kg"}', '2026-11-25 17:45:03.577+00', '2026-11-25 17:45:03.577+00');


--
-- Data for Name: gateway_settings; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.gateway_settings (key, value) VALUES ('disabledSkills', '["night-owl", "discernment-nudge"]');


--
-- Data for Name: github_installation_requests; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: github_installation_states; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: github_installations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: github_reviews; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: leases; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: mail; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: mcp_secret_moves; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: mcp_servers; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.mcp_servers (name, server, "position", created_at, updated_at) VALUES ('docs', '{"url": "https://docs.example.test/mcp"}', 0, '2026-11-24 10:00:00+00', '2026-11-24 10:00:00+00');


--
-- Data for Name: media_assets; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: memories; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: memory_links; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: memory_projects; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: messages; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: model_defaults; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: people; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: profile_revisions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: profiles; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.profiles VALUES ('11111111-1111-4111-8111-111111111111', 'Synthetic', 'x', '', NULL, '{}', '{}', '{}', 1, '2026-11-25 17:45:03.571+00', '2026-11-25 17:45:03.571+00', true);
INSERT INTO public.sessions (id, profile_id, title, channel, created_at) VALUES ('51111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'First chat', 'desktop', '2026-11-25 18:00:00+00');
INSERT INTO public.sessions (id, profile_id, title, channel, created_at) VALUES ('52222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', NULL, 'whatsapp', '2026-11-25 18:05:00+00');
INSERT INTO public.sessions (id, profile_id, title, channel, peer_profile_id, created_at) VALUES ('53333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'Agent to agent', 'agent', '11111111-1111-4111-8111-111111111111', '2026-11-25 18:06:00+00');
INSERT INTO public.channels (id, profile_id, type, address, webhook_token_hash, created_at) VALUES ('61111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'whatsapp', NULL, 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', '2026-11-25 18:01:00+00');
INSERT INTO public.contacts (id, profile_id, channel_id, scope, chat_id, actor_id, title, status, session_id, created_at, updated_at) VALUES ('71111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '61111111-1111-4111-8111-111111111111', 'group', '120363000000000001@g.us', 'actor-1', 'Family group', 'approved', '52222222-2222-4222-8222-222222222222', '2026-11-25 18:05:00+00', '2026-11-25 18:05:00+00');
INSERT INTO public.messages (id, profile_id, session_id, role, content, created_at, seq) VALUES ('81111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '51111111-1111-4111-8111-111111111111', 'user', 'hello', '2026-11-25 18:00:01+00', 1);
INSERT INTO public.messages (id, profile_id, session_id, role, content, created_at, seq) VALUES ('82222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', '51111111-1111-4111-8111-111111111111', 'assistant', 'hi, how can I help?', '2026-11-25 18:00:02+00', 2);
INSERT INTO public.messages (id, profile_id, session_id, role, content, created_at, seq) VALUES ('83333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', '51111111-1111-4111-8111-111111111111', 'user', 'third, with an old clock', '2026-11-25 17:00:00+00', 3);
INSERT INTO public.messages (id, profile_id, session_id, role, content, created_at, author_id, author_name, seq) VALUES ('84444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', '52222222-2222-4222-8222-222222222222', 'user', 'oi gente', '2026-11-25 18:05:01+00', '5511999990001@s.whatsapp.net', 'Ana', 1);
INSERT INTO public.messages (id, profile_id, session_id, role, content, created_at, reactions, channel_message, seq) VALUES ('85555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', '52222222-2222-4222-8222-222222222222', 'assistant', 'oi Ana', '2026-11-25 18:05:02+00', '[{"emoji": "x", "by": "Ana"}]', '{"id": "wamid-1"}', 2);

INSERT INTO public.memories (profile_id, key, content, version, updated_at) VALUES ('11111111-1111-4111-8111-111111111111', 'likes-tea', 'Prefers green tea.', 3, '2026-11-25 18:10:00+00');
INSERT INTO public.memories (profile_id, key, content, version, updated_at, expires_at) VALUES ('11111111-1111-4111-8111-111111111111', 'trip', 'Flying on Friday.', 1, '2126-11-25 18:10:00+00', '2126-11-30 00:00:00+00');
INSERT INTO public.memories (profile_id, key, content, version, updated_at, expires_at) VALUES ('11111111-1111-4111-8111-111111111111', 'over', 'Long gone.', 1, '2020-01-01 10:00:00+00', '2020-01-02 00:00:00+00');
INSERT INTO public.memories (profile_id, key, content, version, updated_at) VALUES ('11111111-1111-4111-8111-111111111111', 'Bad Key!', 'Not a key the core accepts.', 1, '2026-11-25 18:10:00+00');
INSERT INTO public.memory_links (profile_id, a_key, b_key) VALUES ('11111111-1111-4111-8111-111111111111', 'likes-tea', 'trip');
INSERT INTO public.projects (id, profile_id, name, repository_url, created_at) VALUES ('91111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Synthetic site', 'https://example.test/synthetic/site', '2026-11-25 18:20:00+00');
INSERT INTO public.artifact_folders (id, profile_id, name, created_at) VALUES ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Drafts', '2026-11-25 18:30:00+00');
INSERT INTO public.session_artifacts (id, profile_id, session_id, title, type, version, pinned, folder_id, project_id, created_at, updated_at) VALUES ('a2222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', '51111111-1111-4111-8111-111111111111', 'Launch plan', 'markdown', 3, true, 'a1111111-1111-4111-8111-111111111111', '91111111-1111-4111-8111-111111111111', '2026-11-25 18:31:00+00', '2026-11-25 18:35:00+00');
INSERT INTO public.session_artifact_versions (artifact_id, version, content, created_at, author, edit_key) VALUES ('a2222222-2222-4222-8222-222222222222', 1, '# Launch', '2026-11-25 18:31:00+00', 'agent', NULL);
INSERT INTO public.session_artifact_versions (artifact_id, version, content, created_at, author, edit_key) VALUES ('a2222222-2222-4222-8222-222222222222', 3, '# Launch plan', '2026-11-25 18:35:00+00', 'user', 'k1');
INSERT INTO public.session_artifacts (id, profile_id, session_id, title, type, version, created_at, updated_at) VALUES ('a3333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', '51111111-1111-4111-8111-111111111111', 'Sketch', 'whiteboard', 1, '2026-11-25 18:32:00+00', '2026-11-25 18:32:00+00');
INSERT INTO public.session_artifact_versions (artifact_id, version, content, created_at, author) VALUES ('a3333333-3333-4333-8333-333333333333', 1, '{}', '2026-11-25 18:32:00+00', 'agent');
INSERT INTO public.session_artifacts (id, profile_id, session_id, title, type, version, created_at, updated_at) VALUES ('a4444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', '51111111-1111-4111-8111-111111111111', 'Photo', 'picture', 1, '2026-11-25 18:33:00+00', '2026-11-25 18:33:00+00');
INSERT INTO public.session_artifact_versions (artifact_id, version, content, created_at, author) VALUES ('a4444444-4444-4444-8444-444444444444', 1, 'data:image/png;base64,AAAA', '2026-11-25 18:33:00+00', 'agent');
INSERT INTO public.session_artifacts (id, profile_id, session_id, title, type, version, visibility, public_token, created_at, updated_at) VALUES ('a5555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', '51111111-1111-4111-8111-111111111111', 'Open page', 'markdown', 1, 'public', 'ppppppppppppppppppppppppppppppppppppppppppp', '2026-11-25 18:36:00+00', '2026-11-25 18:36:00+00');
INSERT INTO public.session_artifact_versions (artifact_id, version, content, created_at, author) VALUES ('a5555555-5555-4555-8555-555555555555', 1, '# Open', '2026-11-25 18:36:00+00', 'agent');
INSERT INTO public.session_artifacts (id, profile_id, session_id, title, type, version, visibility, public_token, public_password, created_at, updated_at) VALUES ('a6666666-6666-4666-8666-666666666666', '11111111-1111-4111-8111-111111111111', '51111111-1111-4111-8111-111111111111', 'Locked page', 'markdown', 1, 'public', 'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '2026-11-25 18:37:00+00', '2026-11-25 18:37:00+00');
INSERT INTO public.session_artifact_versions (artifact_id, version, content, created_at, author) VALUES ('a6666666-6666-4666-8666-666666666666', 1, '# Locked', '2026-11-25 18:37:00+00', 'agent');
INSERT INTO public.session_artifacts (id, profile_id, session_id, title, type, version, visibility, public_token, public_password, created_at, updated_at) VALUES ('a7777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111', '51111111-1111-4111-8111-111111111111', 'Odd lock', 'markdown', 1, 'public', 'rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr', 'argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', '2026-11-25 18:38:00+00', '2026-11-25 18:38:00+00');
INSERT INTO public.session_artifact_versions (artifact_id, version, content, created_at, author) VALUES ('a7777777-7777-4777-8777-777777777777', 1, '# Odd', '2026-11-25 18:38:00+00', 'agent');
INSERT INTO public.schedules (id, profile_id, session_id, name, instruction, cron, time_zone, created_by, created_at) VALUES ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '51111111-1111-4111-8111-111111111111', 'Morning note', 'Say good morning.', '0 9 * * *', 'America/Sao_Paulo', 'user', '2026-11-25 18:30:00+00');
INSERT INTO public.schedules (id, profile_id, name, instruction, at, time_zone, next_run_at, created_by, created_at) VALUES ('a2222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'Far ahead', 'Check the synthetic site.', '2126-11-25 18:30:00+00', 'UTC', '2126-11-25 18:30:00+00', 'agent', '2026-11-25 18:30:00+00');
INSERT INTO public.schedules (id, profile_id, name, instruction, at, time_zone, enabled, last_run_at, created_by, created_at) VALUES ('a3333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'Already done', 'Long past.', '2020-01-01 10:00:00+00', 'UTC', false, '2020-01-01 10:00:00+00', 'user', '2019-12-31 10:00:00+00');
INSERT INTO public.schedules (id, profile_id, name, instruction, cron, time_zone, created_by, created_at) VALUES ('a4444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', 'Too often', 'Every minute.', '* * * * *', 'UTC', 'user', '2026-11-25 18:30:00+00');
INSERT INTO public.memory_projects (profile_id, memory_key, project_id) VALUES ('11111111-1111-4111-8111-111111111111', 'likes-tea', '91111111-1111-4111-8111-111111111111');

--
-- Data for Name: projects; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: providers; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.providers (id, name, kind, auth_mode, created_at, credential, base_url, active, label) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'groq', 'groq', NULL, '2026-11-25 17:45:03.577+00', NULL, NULL, true, 'Groq work');
INSERT INTO public.providers (id, name, kind, auth_mode, created_at, credential, base_url, active, label) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'openai', 'openai', 'codex', '2026-11-25 17:45:03.577+00', NULL, NULL, true, 'ChatGPT');
INSERT INTO public.providers (id, name, kind, auth_mode, created_at, credential, base_url, active, label) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'anthropic', 'anthropic', NULL, '2026-11-25 17:45:03.577+00', 'subscription', NULL, true, 'Claude Max');


--
-- Data for Name: pull_watchers; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: push_subscriptions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: release_reads; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: remote_machines; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.remote_machines VALUES ('22222222-2222-4222-8222-222222222222', 'Studio Mac', 'macos', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2026-11-25 17:45:03.572+00', NULL, '["shell", "computer"]', 'unknown', '1.4.0', 'macOS 15');


--
-- Data for Name: remote_tasks; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: runs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: schedule_runs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: schedules; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: secret_agents; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: secret_entries; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: secret_fields; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: secrets; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.secrets VALUES ('11111111-1111-4111-8111-111111111111', 'channel:telegram', '{"iv": "3Db9oQLwb1JS3r/6", "tag": "XRxY8CAJ/CAcs/9RxKO7dQ==", "keyId": "local", "version": 1, "ciphertext": "yMVsZwJemgnrJ2TnpTOwN/1T1BlYGhI2NPc="}', '2026-11-25 17:45:03.579+00', '2026-11-25 17:45:03.579+00');


--
-- Data for Name: session_artifact_versions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: session_artifacts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: session_loads; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: session_worktrees; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: skills; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.skills (name, description, instructions, origin, created_at, updated_at) VALUES ('brief-writer', 'Use when asked to write a brief.', 'Ask who reads it, then write it in five lines.', '{"url": "https://github.com/example/skills", "ref": "HEAD", "license": "MIT", "importedAt": "2026-11-20T10:00:00.000Z"}', '2026-11-20 10:00:00+00', '2026-11-21 10:00:00+00');
INSERT INTO public.skills (name, description, instructions, created_at, updated_at) VALUES ('night-owl', 'Use when it is late.', 'Keep answers short after midnight.', '2026-11-22 10:00:00+00', '2026-11-22 10:00:00+00');
INSERT INTO public.skills (name, description, instructions, created_at, updated_at) VALUES ('Bad Name', 'A name the core does not accept.', 'Nothing.', '2026-11-23 10:00:00+00', '2026-11-23 10:00:00+00');


--
-- Data for Name: ssh_keys; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: workspace_snapshots; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: x_accounts; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: x_connect_states; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Name: events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.events_id_seq', 1, false);


--
-- Name: leases_fence_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.leases_fence_seq', 1, false);


--
-- Name: messages_seq_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.messages_seq_seq', 1, false);


--
-- Name: artifact_folders artifact_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_folders
    ADD CONSTRAINT artifact_folders_pkey PRIMARY KEY (id);


--
-- Name: artifacts artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);


--
-- Name: channel_auth channel_auth_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_auth
    ADD CONSTRAINT channel_auth_pkey PRIMARY KEY (channel_id);


--
-- Name: channel_connections channel_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_connections
    ADD CONSTRAINT channel_connections_pkey PRIMARY KEY (channel_id);


--
-- Name: channel_inbox channel_inbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_inbox
    ADD CONSTRAINT channel_inbox_pkey PRIMARY KEY (id);


--
-- Name: channels channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);


--
-- Name: checkpoints checkpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkpoints
    ADD CONSTRAINT checkpoints_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: decision_usage decision_usage_day_use_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision_usage
    ADD CONSTRAINT decision_usage_day_use_pk PRIMARY KEY (day, use);


--
-- Name: deliveries deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_pkey PRIMARY KEY (id);


--
-- Name: device_pairings device_pairings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_pairings
    ADD CONSTRAINT device_pairings_pkey PRIMARY KEY (code_hash);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: email_bindings email_bindings_address_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_bindings
    ADD CONSTRAINT email_bindings_address_key UNIQUE (address);


--
-- Name: email_bindings email_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_bindings
    ADD CONSTRAINT email_bindings_pkey PRIMARY KEY (channel_id);


--
-- Name: email_log email_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_log
    ADD CONSTRAINT email_log_pkey PRIMARY KEY (id);


--
-- Name: email_threads email_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_threads
    ADD CONSTRAINT email_threads_pkey PRIMARY KEY (channel_id, chat_id);


--
-- Name: email_domains email_windows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_domains
    ADD CONSTRAINT email_windows_pkey PRIMARY KEY (id);


--
-- Name: errands errands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.errands
    ADD CONSTRAINT errands_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: file_links file_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_links
    ADD CONSTRAINT file_links_pkey PRIMARY KEY (id);


--
-- Name: model_defaults gateway_model_defaults_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_defaults
    ADD CONSTRAINT gateway_model_defaults_pkey PRIMARY KEY (role);


--
-- Name: gateway_secrets gateway_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gateway_secrets
    ADD CONSTRAINT gateway_secrets_pkey PRIMARY KEY (name);


--
-- Name: gateway_settings gateway_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gateway_settings
    ADD CONSTRAINT gateway_settings_pkey PRIMARY KEY (key);


--
-- Name: github_installation_requests github_installation_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_installation_requests
    ADD CONSTRAINT github_installation_requests_pkey PRIMARY KEY (github_user_id);


--
-- Name: github_installation_states github_installation_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_installation_states
    ADD CONSTRAINT github_installation_states_pkey PRIMARY KEY (hash);


--
-- Name: github_installations github_installations_installation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_installations
    ADD CONSTRAINT github_installations_installation_id_key UNIQUE (installation_id);


--
-- Name: github_installations github_installations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_installations
    ADD CONSTRAINT github_installations_pkey PRIMARY KEY (id);


--
-- Name: github_reviews github_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_reviews
    ADD CONSTRAINT github_reviews_pkey PRIMARY KEY (id);


--
-- Name: leases leases_profile_id_resource_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leases
    ADD CONSTRAINT leases_profile_id_resource_pk PRIMARY KEY (profile_id, resource);


--
-- Name: mail mail_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail
    ADD CONSTRAINT mail_pkey PRIMARY KEY (id);


--
-- Name: mcp_secret_moves mcp_secret_moves_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_secret_moves
    ADD CONSTRAINT mcp_secret_moves_pkey PRIMARY KEY (profile_id, from_name);


--
-- Name: mcp_servers mcp_servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_servers
    ADD CONSTRAINT mcp_servers_pkey PRIMARY KEY (name);


--
-- Name: media_assets media_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_pkey PRIMARY KEY (id);


--
-- Name: memories memories_profile_id_key_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_profile_id_key_pk PRIMARY KEY (profile_id, key);


--
-- Name: memory_links memory_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_links
    ADD CONSTRAINT memory_links_pkey PRIMARY KEY (profile_id, a_key, b_key);


--
-- Name: memory_projects memory_projects_profile_id_memory_key_project_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_projects
    ADD CONSTRAINT memory_projects_profile_id_memory_key_project_id_pk PRIMARY KEY (profile_id, memory_key, project_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: people people_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people
    ADD CONSTRAINT people_pkey PRIMARY KEY (channel_id, actor_id);


--
-- Name: profile_revisions profile_revisions_profile_id_version_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profile_revisions
    ADD CONSTRAINT profile_revisions_profile_id_version_pk PRIMARY KEY (profile_id, version);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: providers providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.providers
    ADD CONSTRAINT providers_pkey PRIMARY KEY (id);


--
-- Name: pull_watchers pull_watchers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pull_watchers
    ADD CONSTRAINT pull_watchers_pkey PRIMARY KEY (id);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (endpoint);


--
-- Name: release_reads release_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.release_reads
    ADD CONSTRAINT release_reads_pkey PRIMARY KEY (scope);


--
-- Name: remote_machines remote_machines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_machines
    ADD CONSTRAINT remote_machines_pkey PRIMARY KEY (id);


--
-- Name: remote_tasks remote_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_tasks
    ADD CONSTRAINT remote_tasks_pkey PRIMARY KEY (id);


--
-- Name: runs runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);


--
-- Name: schedule_runs schedule_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_runs
    ADD CONSTRAINT schedule_runs_pkey PRIMARY KEY (id);


--
-- Name: schedules schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_pkey PRIMARY KEY (id);


--
-- Name: secret_agents secret_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_agents
    ADD CONSTRAINT secret_agents_pkey PRIMARY KEY (secret_id, profile_id);


--
-- Name: secret_entries secret_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_entries
    ADD CONSTRAINT secret_entries_pkey PRIMARY KEY (id);


--
-- Name: secret_fields secret_fields_env_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_fields
    ADD CONSTRAINT secret_fields_env_name_key UNIQUE (env_name);


--
-- Name: secret_fields secret_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_fields
    ADD CONSTRAINT secret_fields_pkey PRIMARY KEY (secret_id, env_name);


--
-- Name: secrets secrets_profile_id_name_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_profile_id_name_pk PRIMARY KEY (profile_id, name);


--
-- Name: session_artifact_versions session_artifact_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_artifact_versions
    ADD CONSTRAINT session_artifact_versions_pkey PRIMARY KEY (artifact_id, version);


--
-- Name: session_artifacts session_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_artifacts
    ADD CONSTRAINT session_artifacts_pkey PRIMARY KEY (id);


--
-- Name: session_artifacts session_artifacts_public_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_artifacts
    ADD CONSTRAINT session_artifacts_public_token_key UNIQUE (public_token);


--
-- Name: session_loads session_loads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_loads
    ADD CONSTRAINT session_loads_pkey PRIMARY KEY (session_id, kind, name);


--
-- Name: session_worktrees session_worktrees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_worktrees
    ADD CONSTRAINT session_worktrees_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: skills skills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (name);


--
-- Name: ssh_keys ssh_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ssh_keys
    ADD CONSTRAINT ssh_keys_pkey PRIMARY KEY (id);


--
-- Name: workspace_snapshots workspace_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_snapshots
    ADD CONSTRAINT workspace_snapshots_pkey PRIMARY KEY (profile_id, location, path);


--
-- Name: x_accounts x_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.x_accounts
    ADD CONSTRAINT x_accounts_pkey PRIMARY KEY (id);


--
-- Name: x_connect_states x_connect_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.x_connect_states
    ADD CONSTRAINT x_connect_states_pkey PRIMARY KEY (hash);


--
-- Name: artifact_folders_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artifact_folders_profile ON public.artifact_folders USING btree (profile_id, name);


--
-- Name: artifacts_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artifacts_run ON public.artifacts USING btree (run_id, created_at DESC NULLS LAST);


--
-- Name: channel_inbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX channel_inbox_pending ON public.channel_inbox USING btree (channel_id, status, received_at);


--
-- Name: channels_live_per_type; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX channels_live_per_type ON public.channels USING btree (profile_id, type) WHERE (revoked_at IS NULL);


--
-- Name: channels_webhook_token; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX channels_webhook_token ON public.channels USING btree (webhook_token_hash);


--
-- Name: checkpoints_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX checkpoints_run ON public.checkpoints USING btree (run_id, created_at DESC NULLS LAST);


--
-- Name: contacts_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX contacts_identity ON public.contacts USING btree (channel_id, chat_id, actor_id);


--
-- Name: contacts_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_pending ON public.contacts USING btree (profile_id, status);


--
-- Name: deliveries_one_per_run; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX deliveries_one_per_run ON public.deliveries USING btree (run_id) WHERE (run_id IS NOT NULL);


--
-- Name: deliveries_phase; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deliveries_phase ON public.deliveries USING btree (channel_id, status, created_at);


--
-- Name: deliveries_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deliveries_recent ON public.deliveries USING btree (profile_id, created_at DESC NULLS LAST);


--
-- Name: devices_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX devices_token_hash ON public.devices USING btree (token_hash);


--
-- Name: email_domains_per_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX email_domains_per_channel ON public.email_domains USING btree (channel_id, domain);


--
-- Name: email_log_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_log_recent ON public.email_log USING btree (profile_id, created_at DESC);


--
-- Name: errands_open_per_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX errands_open_per_contact ON public.errands USING btree (contact_id) WHERE (status = 'waiting'::public.errand_status);


--
-- Name: errands_waiting; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX errands_waiting ON public.errands USING btree (profile_id, status);


--
-- Name: events_cursor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_cursor ON public.events USING btree (profile_id, id);


--
-- Name: file_links_profile_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_links_profile_expires ON public.file_links USING btree (profile_id, expires_at);


--
-- Name: file_links_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX file_links_token_hash ON public.file_links USING btree (token_hash);


--
-- Name: github_installation_states_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX github_installation_states_expiry ON public.github_installation_states USING btree (expires_at);


--
-- Name: github_reviews_auto_once; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX github_reviews_auto_once ON public.github_reviews USING btree (repository, number, head_sha) WHERE (trigger = 'auto'::text);


--
-- Name: github_reviews_pull; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX github_reviews_pull ON public.github_reviews USING btree (repository, number, created_at);


--
-- Name: mail_inbox; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mail_inbox ON public.mail USING btree (to_session_id, created_at DESC NULLS LAST);


--
-- Name: mail_request_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mail_request_key ON public.mail USING btree (profile_id, from_session_id, request_key);


--
-- Name: media_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_session ON public.media_assets USING btree (profile_id, session_id);


--
-- Name: media_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX media_source ON public.media_assets USING btree (profile_id, source_key);


--
-- Name: memories_expiring; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_expiring ON public.memories USING btree (profile_id, expires_at) WHERE (expires_at IS NOT NULL);


--
-- Name: memories_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_recent ON public.memories USING btree (profile_id, updated_at DESC NULLS LAST);


--
-- Name: memories_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memories_search ON public.memories USING gin (to_tsvector('simple'::regconfig, ((key || ' '::text) || content)));


--
-- Name: memory_links_b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_links_b ON public.memory_links USING btree (profile_id, b_key);


--
-- Name: memory_projects_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_projects_project ON public.memory_projects USING btree (profile_id, project_id);


--
-- Name: messages_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_profile ON public.messages USING btree (profile_id, created_at DESC NULLS LAST);


--
-- Name: messages_request_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_request_key ON public.messages USING btree (session_id, request_key) WHERE (request_key IS NOT NULL);


--
-- Name: messages_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_search ON public.messages USING gin (to_tsvector('simple'::regconfig, content));


--
-- Name: messages_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_session ON public.messages USING btree (session_id, created_at DESC NULLS LAST);


--
-- Name: profile_revisions_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profile_revisions_recent ON public.profile_revisions USING btree (profile_id, version DESC NULLS LAST);


--
-- Name: projects_profile_id_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX projects_profile_id_id ON public.projects USING btree (profile_id, id);


--
-- Name: providers_active_per_kind_auth; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX providers_active_per_kind_auth ON public.providers USING btree (kind, COALESCE(auth_mode, 'api'::text)) WHERE ((revoked_at IS NULL) AND active);


--
-- Name: pull_watchers_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pull_watchers_due ON public.pull_watchers USING btree (next_poll_at) WHERE (status = 'watching'::text);


--
-- Name: pull_watchers_pull; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pull_watchers_pull ON public.pull_watchers USING btree (profile_id, lower(owner), lower(repo), number);


--
-- Name: pull_watchers_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pull_watchers_session ON public.pull_watchers USING btree (session_id);


--
-- Name: remote_tasks_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX remote_tasks_pending ON public.remote_tasks USING btree (machine_id, status, created_at);


--
-- Name: runs_activity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_activity ON public.runs USING btree (profile_id, status, created_at DESC NULLS LAST);


--
-- Name: runs_queued; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_queued ON public.runs USING btree (status) WHERE (status = 'queued'::public.run_status);


--
-- Name: runs_request_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX runs_request_key ON public.runs USING btree (profile_id, session_id, request_key);


--
-- Name: runs_running; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_running ON public.runs USING btree (status) WHERE (status = 'running'::public.run_status);


--
-- Name: runs_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_session ON public.runs USING btree (profile_id, session_id, created_at DESC NULLS LAST);


--
-- Name: runs_subagent_spawn; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX runs_subagent_spawn ON public.runs USING btree (profile_id, ((subagent ->> 'parentRunId'::text)), ((subagent ->> 'spawnKey'::text))) WHERE (subagent IS NOT NULL);


--
-- Name: runs_unreported_subagent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_unreported_subagent ON public.runs USING btree (status) WHERE ((subagent IS NOT NULL) AND (subagent_reported_at IS NULL));


--
-- Name: schedule_runs_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schedule_runs_schedule ON public.schedule_runs USING btree (schedule_id, created_at DESC);


--
-- Name: schedules_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schedules_due ON public.schedules USING btree (next_run_at) WHERE enabled;


--
-- Name: schedules_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schedules_profile ON public.schedules USING btree (profile_id, created_at);


--
-- Name: secret_agents_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX secret_agents_profile ON public.secret_agents USING btree (profile_id);


--
-- Name: session_artifacts_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_artifacts_session ON public.session_artifacts USING btree (session_id, created_at);


--
-- Name: session_worktrees_active_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_worktrees_active_source ON public.session_worktrees USING btree (source) WHERE (removed_at IS NULL);


--
-- Name: session_worktrees_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX session_worktrees_name ON public.session_worktrees USING btree (session_id, name) WHERE (removed_at IS NULL);


--
-- Name: session_worktrees_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX session_worktrees_source ON public.session_worktrees USING btree (session_id, source) WHERE (removed_at IS NULL);


--
-- Name: sessions_learning; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sessions_learning ON public.sessions USING btree (profile_id) WHERE (channel = 'learning'::text);


--
-- Name: sessions_peer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_peer ON public.sessions USING btree (profile_id, peer_profile_id);


--
-- Name: sessions_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_recent ON public.sessions USING btree (profile_id, created_at DESC NULLS LAST);


--
-- Name: ssh_keys_public_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ssh_keys_public_key ON public.ssh_keys USING btree (public_key);


--
-- Name: x_accounts_x_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX x_accounts_x_user_id ON public.x_accounts USING btree (x_user_id);


--
-- Name: artifact_folders artifact_folders_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_folders
    ADD CONSTRAINT artifact_folders_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: artifacts artifacts_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: artifacts artifacts_run_id_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_run_id_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: channel_auth channel_auth_channel_id_channels_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_auth
    ADD CONSTRAINT channel_auth_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: channel_auth channel_auth_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_auth
    ADD CONSTRAINT channel_auth_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: channel_connections channel_connections_channel_id_channels_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_connections
    ADD CONSTRAINT channel_connections_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: channel_connections channel_connections_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_connections
    ADD CONSTRAINT channel_connections_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: channel_inbox channel_inbox_channel_id_channels_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_inbox
    ADD CONSTRAINT channel_inbox_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: channel_inbox channel_inbox_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_inbox
    ADD CONSTRAINT channel_inbox_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: channels channels_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: checkpoints checkpoints_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkpoints
    ADD CONSTRAINT checkpoints_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: checkpoints checkpoints_run_id_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkpoints
    ADD CONSTRAINT checkpoints_run_id_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_channel_id_channels_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_session_id_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_session_id_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;


--
-- Name: deliveries deliveries_channel_id_channels_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_channel_id_channels_id_fk FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: deliveries deliveries_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media_assets(id) ON DELETE CASCADE;


--
-- Name: deliveries deliveries_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: deliveries deliveries_run_id_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_run_id_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: deliveries deliveries_source_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_source_run_id_fkey FOREIGN KEY (source_run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: email_bindings email_bindings_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_bindings
    ADD CONSTRAINT email_bindings_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: email_domains email_domains_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_domains
    ADD CONSTRAINT email_domains_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;


--
-- Name: email_log email_log_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_log
    ADD CONSTRAINT email_log_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: email_log email_log_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_log
    ADD CONSTRAINT email_log_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: email_threads email_threads_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_threads
    ADD CONSTRAINT email_threads_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: email_domains email_windows_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_domains
    ADD CONSTRAINT email_windows_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: email_domains email_windows_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_domains
    ADD CONSTRAINT email_windows_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: errands errands_contact_id_contacts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.errands
    ADD CONSTRAINT errands_contact_id_contacts_id_fk FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: errands errands_from_session_id_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.errands
    ADD CONSTRAINT errands_from_session_id_sessions_id_fk FOREIGN KEY (from_session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: errands errands_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.errands
    ADD CONSTRAINT errands_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: events events_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: file_links file_links_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_links
    ADD CONSTRAINT file_links_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: file_links file_links_session_id_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_links
    ADD CONSTRAINT file_links_session_id_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;


--
-- Name: github_reviews github_reviews_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.github_reviews
    ADD CONSTRAINT github_reviews_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: leases leases_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leases
    ADD CONSTRAINT leases_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: leases leases_session_id_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leases
    ADD CONSTRAINT leases_session_id_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: mail mail_from_session_id_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail
    ADD CONSTRAINT mail_from_session_id_sessions_id_fk FOREIGN KEY (from_session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: mail mail_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail
    ADD CONSTRAINT mail_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: mail mail_to_session_id_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail
    ADD CONSTRAINT mail_to_session_id_sessions_id_fk FOREIGN KEY (to_session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: mcp_secret_moves mcp_secret_moves_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_secret_moves
    ADD CONSTRAINT mcp_secret_moves_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: media_assets media_assets_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: media_assets media_assets_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: media_assets media_assets_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: media_assets media_assets_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: memories memories_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: memories memories_source_session_id_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_source_session_id_sessions_id_fk FOREIGN KEY (source_session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;


--
-- Name: memory_links memory_links_profile_id_a_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_links
    ADD CONSTRAINT memory_links_profile_id_a_key_fkey FOREIGN KEY (profile_id, a_key) REFERENCES public.memories(profile_id, key) ON DELETE CASCADE;


--
-- Name: memory_links memory_links_profile_id_b_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_links
    ADD CONSTRAINT memory_links_profile_id_b_key_fkey FOREIGN KEY (profile_id, b_key) REFERENCES public.memories(profile_id, key) ON DELETE CASCADE;


--
-- Name: memory_projects memory_projects_memory_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_projects
    ADD CONSTRAINT memory_projects_memory_fk FOREIGN KEY (profile_id, memory_key) REFERENCES public.memories(profile_id, key) ON DELETE CASCADE;


--
-- Name: memory_projects memory_projects_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_projects
    ADD CONSTRAINT memory_projects_project_fk FOREIGN KEY (profile_id, project_id) REFERENCES public.projects(profile_id, id) ON DELETE CASCADE;


--
-- Name: messages messages_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: messages messages_run_id_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_run_id_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;


--
-- Name: messages messages_session_id_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_session_id_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: people people_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people
    ADD CONSTRAINT people_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: people people_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people
    ADD CONSTRAINT people_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: profile_revisions profile_revisions_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profile_revisions
    ADD CONSTRAINT profile_revisions_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: projects projects_github_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_github_account_fk FOREIGN KEY (github_account_id) REFERENCES public.github_installations(id) ON DELETE SET NULL;


--
-- Name: projects projects_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: pull_watchers pull_watchers_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pull_watchers
    ADD CONSTRAINT pull_watchers_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: pull_watchers pull_watchers_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pull_watchers
    ADD CONSTRAINT pull_watchers_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: remote_tasks remote_tasks_machine_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_tasks
    ADD CONSTRAINT remote_tasks_machine_id_fkey FOREIGN KEY (machine_id) REFERENCES public.remote_machines(id) ON DELETE CASCADE;


--
-- Name: remote_tasks remote_tasks_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_tasks
    ADD CONSTRAINT remote_tasks_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: runs runs_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: runs runs_relay_to_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_relay_to_sessions_id_fk FOREIGN KEY (relay_to) REFERENCES public.sessions(id) ON DELETE SET NULL;


--
-- Name: runs runs_session_id_sessions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_session_id_sessions_id_fk FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: schedule_runs schedule_runs_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_runs
    ADD CONSTRAINT schedule_runs_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: schedule_runs schedule_runs_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_runs
    ADD CONSTRAINT schedule_runs_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.schedules(id) ON DELETE CASCADE;


--
-- Name: schedules schedules_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: schedules schedules_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: secret_agents secret_agents_granted_by_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_agents
    ADD CONSTRAINT secret_agents_granted_by_profile_id_fkey FOREIGN KEY (granted_by_profile_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: secret_agents secret_agents_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_agents
    ADD CONSTRAINT secret_agents_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: secret_agents secret_agents_secret_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_agents
    ADD CONSTRAINT secret_agents_secret_id_fkey FOREIGN KEY (secret_id) REFERENCES public.secret_entries(id) ON DELETE CASCADE;


--
-- Name: secret_entries secret_entries_created_by_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_entries
    ADD CONSTRAINT secret_entries_created_by_profile_id_fkey FOREIGN KEY (created_by_profile_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: secret_fields secret_fields_secret_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_fields
    ADD CONSTRAINT secret_fields_secret_id_fkey FOREIGN KEY (secret_id) REFERENCES public.secret_entries(id) ON DELETE CASCADE;


--
-- Name: secrets secrets_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: session_artifact_versions session_artifact_versions_artifact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_artifact_versions
    ADD CONSTRAINT session_artifact_versions_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.session_artifacts(id) ON DELETE CASCADE;


--
-- Name: session_artifacts session_artifacts_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_artifacts
    ADD CONSTRAINT session_artifacts_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.artifact_folders(id) ON DELETE SET NULL;


--
-- Name: session_artifacts session_artifacts_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_artifacts
    ADD CONSTRAINT session_artifacts_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: session_loads session_loads_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_loads
    ADD CONSTRAINT session_loads_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: session_loads session_loads_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_loads
    ADD CONSTRAINT session_loads_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: session_worktrees session_worktrees_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_worktrees
    ADD CONSTRAINT session_worktrees_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: session_worktrees session_worktrees_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_worktrees
    ADD CONSTRAINT session_worktrees_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_peer_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_peer_profile_id_profiles_id_fk FOREIGN KEY (peer_profile_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: sessions sessions_profile_id_profiles_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_profile_id_profiles_id_fk FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_project_profile_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_project_profile_fk FOREIGN KEY (profile_id, project_id) REFERENCES public.projects(profile_id, id);


--
-- Name: skills skills_author_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skills
    ADD CONSTRAINT skills_author_profile_id_fkey FOREIGN KEY (author_profile_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: workspace_snapshots workspace_snapshots_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_snapshots
    ADD CONSTRAINT workspace_snapshots_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


