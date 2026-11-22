package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const proxyDiscoveryPy = `
import concurrent.futures, datetime, glob, json, os, re, shutil, socket, ssl, subprocess

def run(cmd, timeout=5):
    try:
        return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=timeout).stdout
    except Exception:
        return ''

routes = []
seen = set()

def add_route(engine, domain, upstream, cfg_path=''):
    domain = domain.strip().strip(';').replace('https://', '').replace('http://', '').split('/')[0]
    if not domain or domain in ('_', 'localhost', '0.0.0.0', '*') or ':' in domain and domain.startswith(':'):
        return
    if '.' not in domain:
        return
    key = (engine, domain, upstream)
    if key in seen:
        return
    seen.add(key)
    routes.append({
        'engine': engine,
        'domain': domain,
        'url': f'https://{domain}',
        'upstream': upstream.strip(),
        'configPath': cfg_path,
    })

def parse_caddyfile(text, cfg_path):
    lines = text.splitlines()
    current_domains = []
    depth = 0
    for raw in lines:
        line = raw.split('#', 1)[0].strip()
        if not line:
            continue
        if depth == 0 and '{' in line:
            head = line.split('{', 1)[0].strip()
            if head and not head.startswith(('(', '@')):
                current_domains = [d.strip().rstrip(',') for d in head.split() if '.' in d]
            depth += line.count('{') - line.count('}')
            continue
        if depth > 0:
            m_rp = re.match(r'^reverse_proxy\s+(?:@\S+\s+)?(.+)$', line)
            if m_rp and current_domains:
                upstream = m_rp.group(1).split('{')[0].strip()
                for d in current_domains:
                    add_route('caddy', d, upstream, cfg_path)
            m_redir = re.match(r'^redir\s+(\S+)', line)
            if m_redir and current_domains and not any(r['domain'] == current_domains[0] for r in routes):
                for d in current_domains:
                    add_route('caddy', d, f"redir -> {m_redir.group(1)}", cfg_path)
            depth += line.count('{') - line.count('}')
            if depth <= 0:
                depth = 0
                current_domains = []

for p in ('/etc/caddy/Caddyfile', '/srv/docker/caddy/Caddyfile'):
    if os.path.isfile(p):
        try:
            parse_caddyfile(open(p, errors='replace').read(), p)
        except Exception:
            pass

if shutil.which('docker'):
    names = run(['docker', 'ps', '--format', '{{.Names}}']).splitlines()
    for name in names:
        if 'caddy' in name.lower():
            txt = run(['docker', 'exec', name, 'cat', '/etc/caddy/Caddyfile'])
            if txt:
                parse_caddyfile(txt, f'docker:{name}:/etc/caddy/Caddyfile')

nginx_globs = [
    '/etc/nginx/sites-enabled/*',
    '/etc/nginx/conf.d/*.conf',
    '/opt/1panel/apps/openresty/*/conf/conf.d/*.conf',
    '/opt/1panel/www/conf.d/*.conf',
]
for pattern in nginx_globs:
    for p in glob.glob(pattern):
        if not os.path.isfile(p):
            continue
        try:
            txt = open(p, errors='replace').read()
            blocks = re.split(r'\bserver\s*\{', txt)
            for blk in blocks[1:]:
                sn = re.search(r'server_name\s+([^;]+);', blk)
                pp = re.search(r'proxy_pass\s+([^;]+);', blk)
                if sn and pp:
                    for dom in sn.group(1).split():
                        add_route('nginx', dom, pp.group(1), p)
        except Exception:
            pass

for p in ('/etc/cloudflared/config.yml', '/root/.cloudflared/config.yml'):
    if os.path.isfile(p):
        try:
            txt = open(p, errors='replace').read()
            cur_host = None
            for line in txt.splitlines():
                hm = re.search(r'hostname:\s*(\S+)', line)
                sm = re.search(r'service:\s*(\S+)', line)
                if hm:
                    cur_host = hm.group(1)
                elif sm and cur_host:
                    add_route('cloudflared', cur_host, sm.group(1), p)
                    cur_host = None
        except Exception:
            pass

def check_tls(domain):
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((domain, 443), timeout=3) as sock:
            with ctx.wrap_socket(sock, server_hostname=domain) as ssock:
                cert = ssock.getpeercert()
                not_after = cert.get('notAfter')
                issuer = ''
                for tup in cert.get('issuer', ()):
                    for k, v in tup:
                        if k in ('organizationName', 'commonName'):
                            issuer = v
                if not_after:
                    exp = datetime.datetime.strptime(not_after, '%b %d %H:%M:%S %Y %Z').replace(tzinfo=datetime.timezone.utc)
                    days = int((exp - datetime.datetime.now(datetime.timezone.utc)).total_seconds() // 86400)
                    return days, issuer
    except Exception:
        pass
    return None, ''

unique_domains = list({r['domain'] for r in routes})
tls_map = {}
if unique_domains:
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(check_tls, d): d for d in unique_domains[:16]}
        for f in concurrent.futures.as_completed(futs):
            d = futs[f]
            try:
                tls_map[d] = f.result()
            except Exception:
                tls_map[d] = (None, '')

for r in routes:
    days, issuer = tls_map.get(r['domain'], (None, ''))
    r['tlsDaysLeft'] = days
    if issuer:
        r['tlsIssuer'] = issuer

print(json.dumps({'routes': routes}))
`

func collectProxyRoutes(srv ServerConfig) ([]ProxyRoute, error) {
	res, err := execScript(srv, "python3 - <<'PYEOF'\n"+proxyDiscoveryPy+"\nPYEOF\n", ExecOpts{
		Timeout: 22 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Routes []ProxyRoute `json:"routes"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &parsed); err != nil {
		return nil, err
	}
	if parsed.Routes == nil {
		parsed.Routes = []ProxyRoute{}
	}
	return parsed.Routes, nil
}

const diskAssetsPy = `
import glob, json, os, shutil, subprocess

def run(cmd, timeout=12):
    try:
        return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=timeout).stdout
    except subprocess.TimeoutExpired as e:
        out = e.stdout
        if isinstance(out, bytes):
            return out.decode('utf-8', 'replace')
        return out or ''
    except Exception:
        return ''

import time
from concurrent.futures import ThreadPoolExecutor

skip_top = {'proc', 'sys', 'dev', 'run', 'tmp', 'snap', 'lost+found', 'mnt', 'media'}
priority_order = ['var', 'data', 'opt', 'home', 'root', 'srv', 'usr', 'etc', 'boot']
root_dev = os.stat('/').st_dev
cand_dirs = []
try:
    entries = os.listdir('/')
except Exception:
    entries = []
for name in entries:
    if name in skip_top:
        continue
    full = '/' + name
    try:
        if os.path.islink(full) or not os.path.isdir(full):
            continue
        if os.stat(full).st_dev != root_dev:
            continue
        cand_dirs.append(full)
    except Exception:
        continue

def dir_rank(p):
    base = p.lstrip('/')
    return (priority_order.index(base) if base in priority_order else 99, base)

cand_dirs.sort(key=dir_rank)

# Probe GNU du vs BusyBox du once
gnu_du = subprocess.run(['du', '-x', '-B1', '--max-depth=0', '/etc'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).returncode == 0
du_deadline = time.monotonic() + 28.0

def scan_dir(d):
    rem = du_deadline - time.monotonic()
    if rem < 1.5:
        return []
    per_timeout = min(12.0, rem)
    if gnu_du:
        out = run(['du', '-x', '-B1', '--max-depth=1', d], timeout=per_timeout)
        mult = 1
    else:
        out = run(['du', '-x', '-k', '-d', '1', d], timeout=per_timeout)
        mult = 1024
    res = []
    for line in out.splitlines():
        parts = line.split('\t', 1)
        if len(parts) != 2:
            continue
        try:
            sz = int(parts[0]) * mult
        except Exception:
            continue
        p = parts[1].strip()
        if not p or p == '/' or sz < 20 * 1024 * 1024:
            continue
        res.append((p, sz))
    return res

def collect_docker_df():
    items = []
    if shutil.which('docker'):
        out = run(['docker', 'system', 'df', '--format', '{{json .}}'], timeout=10)
        for line in out.splitlines():
            if not line.strip():
                continue
            try:
                item = json.loads(line)
                items.append({
                    'type': item.get('Type', ''),
                    'total': str(item.get('TotalCount', '')),
                    'active': str(item.get('Active', '')),
                    'size': item.get('Size', ''),
                    'reclaimable': item.get('Reclaimable', ''),
                })
            except Exception:
                pass
    return items

def collect_crontabs():
    crons = []
    def parse_cron(text, src, has_user_col=False):
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line.startswith('#') or '=' in line.split()[0]:
                continue
            parts = line.split()
            if line.startswith('@'):
                if has_user_col and len(parts) >= 3:
                    crons.append({'source': src, 'schedule': parts[0], 'command': ' '.join(parts[2:])})
                elif len(parts) >= 2:
                    crons.append({'source': src, 'schedule': parts[0], 'command': ' '.join(parts[1:])})
            else:
                if has_user_col and len(parts) >= 7:
                    crons.append({'source': src, 'schedule': ' '.join(parts[:5]), 'command': ' '.join(parts[6:])})
                elif len(parts) >= 6:
                    crons.append({'source': src, 'schedule': ' '.join(parts[:5]), 'command': ' '.join(parts[5:])})
    parse_cron(run(['crontab', '-l']), 'root crontab', False)
    for u in ('ubuntu', 'www-data'):
        out = run(['crontab', '-u', u, '-l'])
        if out:
            parse_cron(out, f'{u} crontab', False)
    for f in sorted(glob.glob('/etc/cron.d/*')):
        if os.path.isfile(f):
            try:
                parse_cron(open(f, errors='replace').read(), f, True)
            except Exception:
                pass
    return crons[:30]

def collect_timers():
    items = []
    t_out = run(['systemctl', 'list-timers', '--no-pager', '--no-legend', '--plain'])
    for line in t_out.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        unit = parts[-2]
        activates = parts[-1]
        next_run = ' '.join(parts[:3]) if parts[0] != '-' else 'inactive'
        items.append({'name': unit.replace('.timer', ''), 'next': next_run, 'activates': activates})
    return items[:15]

def collect_runtimes():
    items = []
    checks = [
        ('Docker', ['docker', '--version']),
        ('Node.js', ['node', '-v']),
        ('Python3', ['python3', '--version']),
        ('Go', ['go', 'version']),
        ('Nginx', ['nginx', '-v']),
        ('Caddy', ['caddy', 'version']),
        ('Tailscale', ['tailscale', 'version']),
        ('Git', ['git', '--version']),
    ]
    for name, cmd in checks:
        if not shutil.which(cmd[0]):
            continue
        try:
            r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=3)
            ver = (r.stdout.splitlines()[0] if r.stdout else '').strip()
            if ver:
                items.append({'name': name, 'version': ver[:60]})
        except Exception:
            pass
    return items

# Cap concurrency at 3 workers so low-IOPS VPSes stay responsive while running 2-3x faster
with ThreadPoolExecutor(max_workers=3) as pool:
    f_docker = pool.submit(collect_docker_df)
    f_crons = pool.submit(collect_crontabs)
    f_timers = pool.submit(collect_timers)
    f_runtimes = pool.submit(collect_runtimes)
    f_dirs = [pool.submit(scan_dir, d) for d in cand_dirs]

    top_map = {}
    for fd in f_dirs:
        try:
            for p, sz in fd.result():
                top_map[p] = sz
        except Exception:
            pass
    docker_df = f_docker.result()
    crontabs = f_crons.result()
    timers = f_timers.result()
    runtimes = f_runtimes.result()

top_dirs = [{'path': k, 'bytes': v} for k, v in top_map.items()]
top_dirs.sort(key=lambda x: x['bytes'], reverse=True)
top_dirs = top_dirs[:14]

print(json.dumps({
    'topDirs': top_dirs,
    'dockerDf': docker_df,
    'crontabs': crontabs,
    'timers': timers,
    'runtimes': runtimes,
}))
`

func collectDiskAndAssets(srv ServerConfig) (DiskAuditData, error) {
	res, err := execScript(srv, "python3 - <<'PYEOF'\n"+diskAssetsPy+"\nPYEOF\n", ExecOpts{
		Timeout: 45 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return DiskAuditData{}, err
	}
	var out DiskAuditData
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &out); err != nil {
		return DiskAuditData{}, err
	}
	if out.TopDirs == nil {
		out.TopDirs = []DiskTopDir{}
	}
	if out.DockerDf == nil {
		out.DockerDf = []DockerDfItem{}
	}
	if out.Crontabs == nil {
		out.Crontabs = []CrontabItem{}
	}
	if out.Timers == nil {
		out.Timers = []TimerItem{}
	}
	if out.Runtimes == nil {
		out.Runtimes = []RuntimeItem{}
	}
	return out, nil
}

func pruneDockerSpace(srv ServerConfig, target string) (string, error) {
	cmd := "docker image prune -f"
	switch target {
	case "builder":
		cmd = "docker builder prune -f"
	case "containers":
		cmd = "docker container prune -f"
	}
	res, err := execScript(srv, cmd, ExecOpts{Timeout: 30 * time.Second, Sudo: true})
	if err != nil {
		return "", err
	}
	if res.Code != 0 {
		msg := strings.TrimSpace(res.Stderr)
		if msg == "" {
			msg = "清理失败"
		}
		return "", errors.New(msg)
	}
	return strings.TrimSpace(res.Stdout), nil
}

var (
	reNftTable   = regexp.MustCompile(`^table\s+([a-z0-9_]+\s+[a-z0-9_-]+)\s*\{`)
	reNftChain   = regexp.MustCompile(`^\s*chain\s+([a-zA-Z0-9_-]+)\s*\{`)
	reNftHandle  = regexp.MustCompile(`#\s*handle\s+(\d+)\s*$`)
	reNftProto   = regexp.MustCompile(`\b(tcp|udp)\s+dport\s+(\{[^}]+\}|@[a-zA-Z0-9_]+|\d+(?:-\d+)?)`)
	reNftComment = regexp.MustCompile(`comment\s+"([^"]+)"`)
	reNftTblVal  = regexp.MustCompile(`^[a-z0-9_]+\s+[a-z0-9_-]+$`)
	reNftChnVal  = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
	reNftPortVal = regexp.MustCompile(`^\d{1,5}(-\d{1,5})?$`)
	reSafeComm   = regexp.MustCompile(`[^a-zA-Z0-9_\p{Han} .:-]`)
)

func parseNftRulesFromText(rawNft string) ([]NftRule, *NftTarget) {
	rules := []NftRule{}
	curTable := ""
	curChain := ""
	var target *NftTarget

	for _, line := range strings.Split(rawNft, "\n") {
		if m := reNftTable.FindStringSubmatch(line); m != nil {
			curTable = strings.TrimSpace(m[1])
			curChain = ""
			continue
		}
		if m := reNftChain.FindStringSubmatch(line); m != nil {
			curChain = m[1]
			continue
		}
		if curTable == "" || curChain == "" || strings.ToLower(curChain) != "input" {
			continue
		}
		if target == nil && !strings.HasPrefix(curTable, "ip filter") && !strings.HasPrefix(curTable, "ip6 filter") {
			target = &NftTarget{Table: curTable, Chain: curChain}
		}
		hm := reNftHandle.FindStringSubmatch(line)
		if hm == nil {
			continue
		}
		handle, _ := strconv.Atoi(hm[1])
		clean := strings.TrimSpace(reNftHandle.ReplaceAllString(line, ""))
		if clean == "" || strings.HasPrefix(clean, "type filter") {
			continue
		}
		proto := ""
		ports := ""
		if pm := reNftProto.FindStringSubmatch(clean); pm != nil {
			proto = pm[1]
			ports = pm[2]
		}
		comment := ""
		if cm := reNftComment.FindStringSubmatch(clean); cm != nil {
			comment = cm[1]
		}
		action := "RULE"
		if strings.Contains(clean, " drop") || strings.HasSuffix(clean, "drop") {
			action = "DROP"
		} else if strings.Contains(clean, " reject") {
			action = "REJECT"
		} else if strings.Contains(clean, " accept") || strings.HasSuffix(clean, "accept") {
			action = "ACCEPT"
		}
		rules = append(rules, NftRule{
			Table:   curTable,
			Chain:   curChain,
			Handle:  handle,
			Proto:   proto,
			Ports:   ports,
			Action:  action,
			Comment: comment,
			Raw:     clean,
		})
	}
	return rules, target
}

func addNftPortRule(srv ServerConfig, table, chain, port, proto, comment string) (string, error) {
	if !reNftTblVal.MatchString(table) || !reNftChnVal.MatchString(chain) {
		return "", errors.New("非法的 nftables 表或链名称")
	}
	if !reNftPortVal.MatchString(port) {
		return "", errors.New("端口格式不正确（如 8080 或 8000-8010）")
	}
	if proto != "tcp" && proto != "udp" {
		return "", errors.New("仅支持 tcp 或 udp")
	}
	if comment == "" {
		comment = "AtlasNode"
	}
	comment = reSafeComm.ReplaceAllString(comment, "")
	if runes := []rune(comment); len(runes) > 40 {
		comment = string(runes[:40])
	}

	script := `
set -e
TABLE="$1"
CHAIN="$2"
PROTO="$3"
PORT="$4"
COMMENT="$5"
DROP_HANDLE=$(nft -a list chain $TABLE "$CHAIN" | awk '/drop # handle/{print $NF}' | tail -n 1)
if [ -n "$DROP_HANDLE" ]; then
  nft insert rule $TABLE "$CHAIN" position "$DROP_HANDLE" "$PROTO" dport "$PORT" accept comment "\"$COMMENT\""
else
  nft add rule $TABLE "$CHAIN" "$PROTO" dport "$PORT" accept comment "\"$COMMENT\""
fi
if [ -d /opt/atlasnode ]; then
  LINE="$TABLE|$CHAIN|$PROTO|$PORT|$COMMENT"
  grep -qxF "$LINE" /opt/atlasnode/nft-extra-ports.conf 2>/dev/null || echo "$LINE" >> /opt/atlasnode/nft-extra-ports.conf
fi
echo "OK"
`
	res, err := execScript(srv, script, ExecOpts{
		Args:    []string{table, chain, proto, port, comment},
		Timeout: 12 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return "", err
	}
	if res.Code != 0 {
		msg := strings.TrimSpace(res.Stderr)
		if msg == "" {
			msg = "添加 nftables 规则失败"
		}
		return "", errors.New(msg)
	}
	return strings.TrimSpace(res.Stdout), nil
}

func deleteNftRule(srv ServerConfig, table, chain string, handle int) (string, error) {
	if !reNftTblVal.MatchString(table) || !reNftChnVal.MatchString(chain) {
		return "", errors.New("非法的 nftables 表或链名称")
	}
	if handle < 1 {
		return "", errors.New("非法的规则句柄")
	}
	script := `
set -e
TABLE="$1"
CHAIN="$2"
HANDLE="$3"
RULE_LINE=$(nft -a list chain $TABLE "$CHAIN" | grep "# handle $HANDLE$" || true)
if echo "$RULE_LINE" | grep -qE "dport.*(22|9800)|drop # handle"; then
  echo "出于安全保护，禁止删除 SSH(22)、AtlasNode(9800) 或默认 drop 规则" >&2
  exit 1
fi
nft delete rule $TABLE "$CHAIN" handle "$HANDLE"
echo "OK"
`
	res, err := execScript(srv, script, ExecOpts{
		Args:    []string{table, chain, strconv.Itoa(handle)},
		Timeout: 12 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return "", err
	}
	if res.Code != 0 {
		msg := strings.TrimSpace(res.Stderr)
		if msg == "" {
			msg = "删除 nftables 规则失败"
		}
		return "", errors.New(msg)
	}
	return strings.TrimSpace(res.Stdout), nil
}

func findComposeFile(srv ServerConfig, composeDir string) (string, error) {
	script := `
DIR="$1"
for f in compose.yaml compose.yml docker-compose.yml docker-compose.yaml; do
  if [ -f "$DIR/$f" ]; then echo "$DIR/$f"; exit 0; fi
done
exit 1
`
	res, err := execScript(srv, script, ExecOpts{
		Args:    []string{composeDir},
		Timeout: 8 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return "", err
	}
	out := strings.TrimSpace(res.Stdout)
	if res.Code != 0 || out == "" {
		return "", fmt.Errorf("未在 %s 找到 docker-compose.yml", composeDir)
	}
	return out, nil
}

func isSafeComposeDirToDelete(dir string) bool {
	cleaned := strings.TrimRight(strings.TrimSpace(dir), "/")
	if cleaned == "" || !strings.HasPrefix(cleaned, "/") || strings.Contains(cleaned, "..") {
		return false
	}
	forbidden := map[string]bool{
		"/": true, "/root": true, "/home": true, "/opt": true, "/srv": true,
		"/var": true, "/etc": true, "/usr": true, "/usr/local": true,
		"/usr/local/services": true, "/tmp": true, "/bin": true, "/sbin": true,
		"/lib": true, "/lib64": true, "/boot": true, "/dev": true, "/proc": true,
		"/sys": true, "/run": true, "/mnt": true, "/media": true, "/data": true,
	}
	if forbidden[cleaned] {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(cleaned, "/"), "/")
	if len(parts) < 2 {
		return false
	}
	// Extra guard: never delete /home/<user> directly
	if parts[0] == "home" && len(parts) < 3 {
		return false
	}
	return true
}

func spawnComposeAction(srv ServerConfig, composeDir, project, action string, removeVolumes, removeDir bool) (*StreamProcess, error) {
	rmVolFlag := "0"
	if removeVolumes {
		rmVolFlag = "1"
	}
	rmDirFlag := "0"
	if removeDir && isSafeComposeDirToDelete(composeDir) {
		rmDirFlag = "1"
	}
	script := `set -e
DIR="$1"
PROJ="$2"
ACTION="$3"
RM_VOL="$4"
RM_DIR="$5"
[ -d "$DIR" ] && cd "$DIR"

# Find containers belonging to this compose stack
if [ -n "$PROJ" ]; then
  RUNNING_CIDS=$(docker ps -q --filter "label=com.docker.compose.project=$PROJ" 2>/dev/null || true)
  ALL_CIDS=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJ" 2>/dev/null || true)
else
  RUNNING_CIDS=$(docker ps -q --filter "label=com.docker.compose.project.working_dir=$DIR" 2>/dev/null || true)
  ALL_CIDS=$(docker ps -aq --filter "label=com.docker.compose.project.working_dir=$DIR" 2>/dev/null || true)
fi

# For stop: stopping the running containers of this stack directly is always exact
if [ "$ACTION" = "stop" ]; then
  if [ -z "$RUNNING_CIDS" ]; then
    echo "[AtlasNode] 该栈当前没有运行中的容器"
    exit 0
  fi
  echo "[AtlasNode] 正在停止栈 ${PROJ:-$DIR} 中的容器..."
  echo "$RUNNING_CIDS" | xargs -r docker stop 2>&1
  exit 0
fi

# Inspect one container's labels to recover original -f config_files & --env-file
SAMPLE_CID=$(echo "$ALL_CIDS" | head -n 1)
CFG_FILES=""
ENV_FILE=""
if [ -n "$SAMPLE_CID" ]; then
  CFG_FILES=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$SAMPLE_CID" 2>/dev/null || true)
  ENV_FILE=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.environment_file"}}' "$SAMPLE_CID" 2>/dev/null || true)
fi

# Detect modern Compose v2+ binary first (skip legacy v1.x which rejects compose.yml & v2 syntax)
is_v2() {
  ver=$("$@" version 2>/dev/null || true)
  [ -n "$ver" ] && ! echo "$ver" | grep -qi "version 1\."
}

COMPOSE_CMD=""
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
else
  PARENT_DIR=$(dirname "$DIR")
  for cand in \
    "$DIR/bin/docker-compose" \
    "$PARENT_DIR/bin/docker-compose" \
    /usr/local/bin/docker-compose \
    /usr/libexec/docker/cli-plugins/docker-compose \
    /usr/local/lib/docker/cli-plugins/docker-compose \
    "$HOME/.docker/cli-plugins/docker-compose" \
    "$(command -v docker-compose 2>/dev/null || true)"; do
    if [ -n "$cand" ] && [ -x "$cand" ] && is_v2 "$cand"; then
      COMPOSE_CMD="$cand"
      break
    fi
  done
fi

EXTRA_ARGS=""
if [ -n "$COMPOSE_CMD" ]; then
  if [ -n "$PROJ" ]; then
    EXTRA_ARGS="$EXTRA_ARGS -p $PROJ"
  fi
  if [ -n "$CFG_FILES" ]; then
    OLD_IFS="$IFS"
    IFS=','
    for cf in $CFG_FILES; do
      [ -f "$cf" ] && EXTRA_ARGS="$EXTRA_ARGS -f $cf"
    done
    IFS="$OLD_IFS"
  fi
  if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
    EXTRA_ARGS="$EXTRA_ARGS --env-file $ENV_FILE"
  fi
fi

# If no v2+ binary was found, allow legacy docker-compose v1 if it actually parses this stack's config
if [ -z "$COMPOSE_CMD" ] && command -v docker-compose >/dev/null 2>&1; then
  LEGACY_ARGS=""
  [ -n "$PROJ" ] && LEGACY_ARGS="$LEGACY_ARGS -p $PROJ"
  if [ -n "$CFG_FILES" ]; then
    OLD_IFS="$IFS"
    IFS=','
    for cf in $CFG_FILES; do
      [ -f "$cf" ] && LEGACY_ARGS="$LEGACY_ARGS -f $cf"
    done
    IFS="$OLD_IFS"
  fi
  [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] && LEGACY_ARGS="$LEGACY_ARGS --env-file $ENV_FILE"
  # shellcheck disable=SC2086
  if docker-compose $LEGACY_ARGS config -q >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
    EXTRA_ARGS="$LEGACY_ARGS"
  fi
fi

# Remove entire compose stack (down + force-clean leftover containers + optional dir removal)
if [ "$ACTION" = "remove" ]; then
  VOL_OPT=""
  [ "$RM_VOL" = "1" ] && VOL_OPT="-v"
  if [ -n "$COMPOSE_CMD" ]; then
    echo "[AtlasNode] $PWD -> $COMPOSE_CMD$EXTRA_ARGS down --remove-orphans $VOL_OPT"
    # shellcheck disable=SC2086
    $COMPOSE_CMD $EXTRA_ARGS down --remove-orphans $VOL_OPT 2>&1 || true
  fi
  # Ensure no leftover containers from this stack remain
  if [ -n "$PROJ" ]; then
    LEFT=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJ" 2>/dev/null || true)
  else
    LEFT=$(docker ps -aq --filter "label=com.docker.compose.project.working_dir=$DIR" 2>/dev/null || true)
  fi
  if [ -n "$LEFT" ]; then
    echo "[AtlasNode] 清理剩余栈容器..."
    # shellcheck disable=SC2086
    echo "$LEFT" | xargs -r docker rm -f $VOL_OPT 2>&1
  fi
  if [ "$RM_DIR" = "1" ] && [ -d "$DIR" ]; then
    echo "[AtlasNode] 删除项目目录: $DIR"
    cd /
    rm -rf -- "$DIR"
  fi
  echo "[AtlasNode] 服务 ${PROJ:-$DIR} 已删除"
  exit 0
fi

if [ -n "$COMPOSE_CMD" ]; then
  case "$ACTION" in
    pull_up)
      echo "[AtlasNode] $PWD -> $COMPOSE_CMD$EXTRA_ARGS pull && up -d"
      # shellcheck disable=SC2086
      $COMPOSE_CMD $EXTRA_ARGS pull 2>&1 && $COMPOSE_CMD $EXTRA_ARGS up -d 2>&1
      ;;
    restart)
      echo "[AtlasNode] $PWD -> $COMPOSE_CMD$EXTRA_ARGS restart"
      # shellcheck disable=SC2086
      $COMPOSE_CMD $EXTRA_ARGS restart 2>&1
      ;;
    *)
      echo "[AtlasNode] $PWD -> $COMPOSE_CMD$EXTRA_ARGS up -d"
      # shellcheck disable=SC2086
      $COMPOSE_CMD $EXTRA_ARGS up -d 2>&1
      ;;
  esac
  exit 0
fi

# Fallback when no compatible Compose binary exists on host
case "$ACTION" in
  restart|up)
    if [ -z "$ALL_CIDS" ]; then
      echo "[AtlasNode] 未找到 Compose v2+ 命令，且未匹配到该栈容器" >&2
      exit 127
    fi
    SUB="$ACTION"
    [ "$SUB" = "up" ] && SUB="start"
    echo "[AtlasNode] 未检测到 Compose v2+，自动回退为 docker $SUB 整栈容器..."
    echo "$ALL_CIDS" | xargs -r docker "$SUB" 2>&1
    ;;
  *)
    echo "[AtlasNode] 未找到 Compose v2+ 命令（系统仅装了不兼容新版 compose.yml 的旧版 docker-compose v1），请安装 docker-compose-plugin" >&2
    exit 127
    ;;
esac
`
	return spawnScriptStream(srv, script, ExecOpts{Args: []string{composeDir, project, action, rmVolFlag, rmDirFlag}, Sudo: true})
}

type KeySyncResult struct {
	ServerID   string `json:"serverId"`
	ServerName string `json:"serverName"`
	Status     string `json:"status"` // added | exists | error
	Message    string `json:"message,omitempty"`
}

func syncSshKeyToAllServers(servers []ServerConfig, publicKey string) []KeySyncResult {
	results := make([]KeySyncResult, len(servers))
	var wg sync.WaitGroup
	for i, srv := range servers {
		wg.Add(1)
		go func(idx int, s ServerConfig) {
			defer wg.Done()
			err := addSshKey(s, publicKey)
			if err == nil {
				results[idx] = KeySyncResult{ServerID: s.ID, ServerName: s.Name, Status: "added"}
				return
			}
			if strings.Contains(err.Error(), "已存在") {
				results[idx] = KeySyncResult{ServerID: s.ID, ServerName: s.Name, Status: "exists", Message: "已存在"}
				return
			}
			results[idx] = KeySyncResult{ServerID: s.ID, ServerName: s.Name, Status: "error", Message: err.Error()}
		}(i, srv)
	}
	wg.Wait()
	return results
}

const meshLatencyPy = `
import json, socket, sys, time

targets = json.loads(sys.argv[1])
out = []
for t in targets:
    host = t['host']
    port = int(t.get('port') or 22)
    times = []
    err = None
    for _ in range(3):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(3.0)
        t0 = time.monotonic()
        try:
            s.connect((host, port))
            times.append((time.monotonic() - t0) * 1000.0)
        except Exception as e:
            err = str(e)
        finally:
            s.close()
    if times:
        out.append({'toId': t['id'], 'targetHost': host, 'latencyMs': round(sum(times) / len(times), 1)})
    else:
        out.append({'toId': t['id'], 'targetHost': host, 'latencyMs': None, 'error': err or 'timeout'})
print(json.dumps(out))
`

func measureMeshLatency(servers []ServerConfig) ([]MeshLatencyCell, string) {
	var mu sync.Mutex
	matrix := []MeshLatencyCell{}
	var wg sync.WaitGroup

	type probeTarget struct {
		ID   string `json:"id"`
		Host string `json:"host"`
		Port int    `json:"port"`
	}

	for _, src := range servers {
		wg.Add(1)
		go func(s ServerConfig) {
			defer wg.Done()
			targets := []probeTarget{}
			for _, dst := range servers {
				if dst.ID == s.ID {
					continue
				}
				useTs := s.TailscaleIP != "" && dst.TailscaleIP != ""
				host := dst.PublicIP
				if useTs {
					host = dst.TailscaleIP
				} else if host == "" {
					host = dst.Host
				}
				port := dst.Port
				if port <= 0 {
					port = 22
				}
				if !useTs && dst.JumpHost != nil && dst.JumpHost.Host != "" {
					port = 443
				}
				targets = append(targets, probeTarget{ID: dst.ID, Host: host, Port: port})
			}

			argJSON, _ := json.Marshal(targets)
			res, err := execScript(s, "python3 - \"$1\" <<'PYEOF'\n"+meshLatencyPy+"\nPYEOF\n", ExecOpts{
				Args:    []string{string(argJSON)},
				Timeout: 18 * time.Second,
			})
			if err != nil {
				mu.Lock()
				for _, dst := range targets {
					matrix = append(matrix, MeshLatencyCell{
						FromID:     s.ID,
						ToID:       dst.ID,
						TargetHost: dst.Host,
						LatencyMs:  nil,
						Error:      err.Error(),
					})
				}
				mu.Unlock()
				return
			}
			var items []struct {
				ToID       string   `json:"toId"`
				TargetHost string   `json:"targetHost"`
				LatencyMs  *float64 `json:"latencyMs"`
				Error      string   `json:"error"`
			}
			if json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &items) != nil {
				mu.Lock()
				for _, dst := range targets {
					matrix = append(matrix, MeshLatencyCell{
						FromID:     s.ID,
						ToID:       dst.ID,
						TargetHost: dst.Host,
						LatencyMs:  nil,
						Error:      "解析失败",
					})
				}
				mu.Unlock()
				return
			}
			mu.Lock()
			for _, it := range items {
				matrix = append(matrix, MeshLatencyCell{
					FromID:     s.ID,
					ToID:       it.ToID,
					TargetHost: it.TargetHost,
					LatencyMs:  it.LatencyMs,
					Error:      it.Error,
				})
			}
			mu.Unlock()
		}(src)
	}
	wg.Wait()
	return matrix, time.Now().UTC().Format(time.RFC3339)
}
