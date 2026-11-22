package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const liveStreamPy = `
import json, os, subprocess, sys, time

def read_cpu():
    with open('/proc/stat') as f:
        parts = [int(x) for x in f.readline().split()[1:9]]
    idle = parts[3] + parts[4]
    total = sum(parts)
    return idle, total

def read_net():
    rx_total = 0
    tx_total = 0
    primary_if = ''
    primary_bytes = -1
    with open('/proc/net/dev') as f:
        for line in f.readlines()[2:]:
            if ':' not in line:
                continue
            name, rest = line.split(':', 1)
            name = name.strip()
            if name == 'lo' or name.startswith(('veth', 'br-', 'docker', 'virbr', 'cni', 'flannel')):
                continue
            cols = rest.split()
            rx = int(cols[0])
            tx = int(cols[8])
            if not name.startswith('tailscale'):
                rx_total += rx
                tx_total += tx
            if rx + tx > primary_bytes:
                primary_bytes = rx + tx
                primary_if = name
    if rx_total == 0 and tx_total == 0 and primary_bytes > 0:
        with open('/proc/net/dev') as f:
            for line in f.readlines()[2:]:
                if ':' not in line:
                    continue
                name, rest = line.split(':', 1)
                if name.strip() == primary_if:
                    cols = rest.split()
                    rx_total = int(cols[0])
                    tx_total = int(cols[8])
    return rx_total, tx_total, primary_if

def read_mem():
    info = {}
    with open('/proc/meminfo') as f:
        for line in f:
            parts = line.split()
            if len(parts) >= 2:
                info[parts[0].rstrip(':')] = int(parts[1]) * 1024
    total = info.get('MemTotal', 0)
    avail = info.get('MemAvailable', info.get('MemFree', 0))
    used = max(0, total - avail)
    swap_total = info.get('SwapTotal', 0)
    swap_free = info.get('SwapFree', 0)
    return total, used, avail, swap_total, max(0, swap_total - swap_free)

def read_procs():
    out = []
    try:
        res = subprocess.check_output(
            ['ps', '-eo', 'pid,user,%cpu,%mem,rss,comm', '--sort=-%cpu'],
            text=True, stderr=subprocess.DEVNULL
        )
        for line in res.splitlines()[1:14]:
            parts = line.split(None, 5)
            if len(parts) == 6:
                if parts[5] in ('ps', 'python3') and float(parts[2]) >= 80.0:
                    continue
                out.append({
                    'pid': int(parts[0]),
                    'user': parts[1],
                    'cpu': float(parts[2]),
                    'mem': float(parts[3]),
                    'rssKb': int(parts[4]),
                    'command': parts[5][:60],
                })
                if len(out) >= 8:
                    break
    except Exception:
        pass
    return out

cores = os.cpu_count() or 1
prev_idle, prev_total = read_cpu()
prev_rx, prev_tx, primary_if = read_net()
prev_t = time.monotonic()

single_shot = len(sys.argv) > 1 and sys.argv[1] == '--once'
interval = 0.45 if single_shot else 2.0

while True:
    time.sleep(interval)
    now_t = time.monotonic()
    dt = max(0.1, now_t - prev_t)
    idle, total = read_cpu()
    rx, tx, primary_if = read_net()

    d_total = max(1, total - prev_total)
    d_idle = max(0, idle - prev_idle)
    cpu_pct = round(100.0 * (1.0 - d_idle / d_total), 1)

    rx_bps = max(0.0, (rx - prev_rx) / dt)
    tx_bps = max(0.0, (tx - prev_tx) / dt)

    prev_idle, prev_total = idle, total
    prev_rx, prev_tx = rx, tx
    prev_t = now_t

    mem_total, mem_used, mem_avail, swap_total, swap_used = read_mem()
    mem_pct = round((mem_used / mem_total * 100.0), 1) if mem_total else 0.0

    try:
        la = list(os.getloadavg())
        load_avg = [round(la[0], 2), round(la[1], 2), round(la[2], 2)]
    except Exception:
        load_avg = [0.0, 0.0, 0.0]

    try:
        with open('/proc/uptime') as f:
            uptime = int(float(f.read().split()[0]))
    except Exception:
        uptime = 0

    try:
        st = os.statvfs('/')
        d_total_b = st.f_blocks * st.f_frsize
        d_avail_b = st.f_bavail * st.f_frsize
        d_used_b = d_total_b - (st.f_bfree * st.f_frsize)
        d_pct = round((d_used_b / (d_used_b + d_avail_b) * 100.0), 1) if (d_used_b + d_avail_b) else 0.0
    except Exception:
        d_total_b, d_used_b, d_pct = 0, 0, 0.0

    payload = {
        'timestamp': int(time.time() * 1000),
        'cpuPercent': cpu_pct,
        'cpuCores': cores,
        'loadAvg': load_avg,
        'memTotalBytes': mem_total,
        'memUsedBytes': mem_used,
        'memAvailableBytes': mem_avail,
        'memPercent': mem_pct,
        'swapTotalBytes': swap_total,
        'swapUsedBytes': swap_used,
        'diskRootTotalBytes': d_total_b,
        'diskRootUsedBytes': d_used_b,
        'diskRootPercent': d_pct,
        'netRxBps': round(rx_bps, 1),
        'netTxBps': round(tx_bps, 1),
        'netTotalRxBytes': rx,
        'netTotalTxBytes': tx,
        'netInterface': primary_if,
        'uptimeSeconds': uptime,
        'topProcesses': read_procs(),
    }
    print(json.dumps(payload), flush=True)
    if single_shot:
        break
`

func spawnMetricsStream(srv ServerConfig) (*StreamProcess, error) {
	return spawnScriptStream(srv, "python3 -u - <<'PYEOF'\n"+liveStreamPy+"\nPYEOF\n", ExecOpts{})
}

func collectSingleMetrics(srv ServerConfig) (LiveMetrics, error) {
	res, err := execScript(srv, "python3 -u - --once <<'PYEOF'\n"+liveStreamPy+"\nPYEOF\n", ExecOpts{
		Timeout: 10 * time.Second,
	})
	if err != nil {
		return LiveMetrics{}, err
	}
	lines := strings.Split(strings.TrimSpace(res.Stdout), "\n")
	last := ""
	if len(lines) > 0 {
		last = lines[len(lines)-1]
	}
	var m LiveMetrics
	if err := json.Unmarshal([]byte(last), &m); err != nil {
		return LiveMetrics{}, err
	}
	if m.TopProcesses == nil {
		m.TopProcesses = []ProcessMetric{}
	}
	return m, nil
}

const snapshotPy = `
import json, os, re, shutil, subprocess, time

def run(cmd, timeout=6):
    try:
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=timeout)
        return r.stdout
    except Exception:
        return ''

def get_os():
    try:
        with open('/etc/os-release') as f:
            for line in f:
                if line.startswith('PRETTY_NAME='):
                    return line.split('=', 1)[1].strip().strip('"')
    except Exception:
        pass
    return run(['uname', '-s']).strip()

def get_cpu_model():
    try:
        with open('/proc/cpuinfo') as f:
            for line in f:
                if line.lower().startswith('model name'):
                    return line.split(':', 1)[1].strip()
    except Exception:
        pass
    return 'Unknown CPU'

def get_disks():
    out = run(['df', '-B1', '-T'])
    disks = []
    seen = set()
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 7:
            continue
        dev, fs, total, used, avail, pct, mount = parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]
        if fs in ('tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'proc', 'sysfs', 'cgroup2', 'efivarfs'):
            continue
        if mount.startswith(('/boot/efi', '/snap', '/var/lib/docker', '/run')):
            continue
        if dev in seen:
            continue
        seen.add(dev)
        try:
            disks.append({
                'device': dev,
                'fsType': fs,
                'totalBytes': int(total),
                'usedBytes': int(used),
                'availBytes': int(avail),
                'usePercent': float(pct.rstrip('%')) if pct.endswith('%') else 0.0,
                'mount': mount,
            })
        except Exception:
            pass
    return disks

def get_interfaces():
    ip_json = run(['ip', '-j', 'addr'])
    net_stats = {}
    try:
        with open('/proc/net/dev') as f:
            for line in f.readlines()[2:]:
                if ':' in line:
                    n, rest = line.split(':', 1)
                    cols = rest.split()
                    net_stats[n.strip()] = (int(cols[0]), int(cols[8]))
    except Exception:
        pass
    ifaces = []
    ts_ip = ''
    try:
        data = json.loads(ip_json) if ip_json.strip() else []
        for item in data:
            name = item.get('ifname', '')
            if name == 'lo' or name.startswith(('veth', 'br-', 'docker')):
                continue
            ipv4 = []
            ipv6 = []
            for a in item.get('addr_info', []):
                if a.get('family') == 'inet':
                    ipv4.append(a.get('local'))
                    if name == 'tailscale0' and not ts_ip:
                        ts_ip = a.get('local')
                elif a.get('family') == 'inet6' and not str(a.get('local', '')).startswith('fe80'):
                    ipv6.append(a.get('local'))
            rx, tx = net_stats.get(name, (0, 0))
            ifaces.append({
                'name': name,
                'ipv4': ipv4,
                'ipv6': ipv6,
                'rxBytes': rx,
                'txBytes': tx,
                'state': item.get('operstate', 'UNKNOWN'),
            })
    except Exception:
        pass
    return ifaces, ts_ip

def get_docker():
    if not shutil.which('docker'):
        return False, [], {}
    raw = run(['docker', 'ps', '-a', '--no-trunc', '--format', '{{json .}}'], timeout=8)
    containers = []
    ids = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        try:
            c = json.loads(line)
            containers.append(c)
            ids.append(c.get('ID', ''))
        except Exception:
            pass
    inspect_map = {}
    if ids:
        insp = run(['docker', 'inspect', '--format', '{{.Id}}\t{{index .Config.Labels "com.docker.compose.project"}}\t{{index .Config.Labels "com.docker.compose.project.working_dir"}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}'] + ids, timeout=8)
        for line in insp.splitlines():
            parts = line.split('\t')
            if len(parts) >= 4:
                inspect_map[parts[0]] = {
                    'project': parts[1] or '',
                    'dir': parts[2] or '',
                    'health': parts[3] or '',
                }
    return True, containers, inspect_map

def get_ports():
    out = run(['ss', '-tulnp'], timeout=5)
    ports = []
    seen = set()
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 5:
            continue
        proto = parts[0]
        state = parts[1]
        if proto.startswith('tcp') and state != 'LISTEN':
            continue
        local = parts[4]
        if ':' not in local:
            continue
        idx = local.rfind(':')
        addr = local[:idx].strip('[]')
        if '%' in addr:
            addr = addr.split('%', 1)[0]
        try:
            port = int(local[idx+1:])
        except Exception:
            continue
        proc = ''
        pid = None
        rest = ' '.join(parts[6:]) if len(parts) > 6 else ''
        m = re.search(r'"([^"]+)",pid=(\d+)', rest)
        if m:
            proc = m.group(1)
            pid = int(m.group(2))
        key = (proto, addr, port, proc)
        if key in seen:
            continue
        seen.add(key)
        if addr in ('0.0.0.0', '*', '::'):
            scope = 'public'
        elif addr.startswith('100.'):
            scope = 'tailscale'
        elif addr.startswith('127.') or addr == '::1':
            scope = 'local'
        else:
            scope = 'private'
        ports.append({
            'proto': proto,
            'address': addr,
            'port': port,
            'scope': scope,
            'process': proc or 'unknown',
            'pid': pid,
        })
    return ports

def get_firewall_summary():
    if shutil.which('ufw'):
        st = run(['ufw', 'status'])
        if 'Status: active' in st:
            return {'engine': 'ufw', 'active': True}
    if shutil.which('nft'):
        nft_out = run(['nft', 'list', 'ruleset'])
        if 'hook input' in nft_out and ('drop' in nft_out or 'reject' in nft_out):
            return {'engine': 'nftables', 'active': True}
    if shutil.which('firewall-cmd'):
        st = run(['firewall-cmd', '--state']).strip()
        if st == 'running':
            return {'engine': 'firewalld', 'active': True}
    if shutil.which('ufw'):
        return {'engine': 'ufw', 'active': False}
    return {'engine': 'iptables', 'active': False}

def get_systemd_highlights():
    out = run(['systemctl', 'list-units', '--type=service', '--state=running', '--no-pager', '--no-legend', '--plain'])
    skip_prefixes = (
        'systemd-', 'dbus', 'cron', 'rsyslog', 'getty', 'serial-getty', 'user@',
        'polkit', 'udisks', 'ModemManager', 'networkd-', 'NetworkManager', 'unattended-',
        'snapd', 'multipathd', 'irqbalance', 'packagekit', 'fwupd', 'accounts-', 'avahi-',
        'containerd', 'ssh.service', 'sshd.service', 'rpcbind', 'qemu-guest', 'acpid',
        'atd', 'sysstat', 'thermald', 'upower', 'wpa_supplicant', 'cloud-init', 'tat_agent',
        'barad_agent', 'sgagent', 'qcloud', 'aliyun', 'aegis', 'chrony', 'ntp', 'auditd'
    )
    items = []
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        name, load, active, sub, desc = parts
        if any(name.startswith(p) for p in skip_prefixes):
            continue
        items.append({
            'name': name.replace('.service', ''),
            'description': desc,
            'activeState': active,
            'subState': sub,
        })
    return items[:16]

def read_cpu():
    with open('/proc/stat') as f:
        p = [int(x) for x in f.readline().split()[1:9]]
    return p[3] + p[4], sum(p)

def read_net():
    rx_t, tx_t, p_if, p_b = 0, 0, '', -1
    with open('/proc/net/dev') as f:
        for line in f.readlines()[2:]:
            if ':' not in line: continue
            n, r = line.split(':', 1)
            n = n.strip()
            if n == 'lo' or n.startswith(('veth', 'br-', 'docker', 'virbr')): continue
            c = r.split()
            rx, tx = int(c[0]), int(c[8])
            if not n.startswith('tailscale'):
                rx_t += rx; tx_t += tx
            if rx + tx > p_b:
                p_b = rx + tx; p_if = n
    return rx_t, tx_t, p_if

i1, t1 = read_cpu()
rx1, tx1, pif = read_net()
t_a = time.monotonic()

disks = get_disks()
ifaces, ts_ip = get_interfaces()
docker_ok, containers_raw, inspect_map = get_docker()
ports = get_ports()
fw = get_firewall_summary()
svcs = get_systemd_highlights()

t_b = time.monotonic()
if t_b - t_a < 0.25:
    time.sleep(0.25 - (t_b - t_a))
    t_b = time.monotonic()
i2, t2 = read_cpu()
rx2, tx2, pif = read_net()
dt = max(0.1, t_b - t_a)
cpu_pct = round(100.0 * (1.0 - max(0, i2 - i1) / max(1, t2 - t1)), 1)

mem = {}
with open('/proc/meminfo') as f:
    for line in f:
        p = line.split()
        if len(p) >= 2: mem[p[0].rstrip(':')] = int(p[1]) * 1024
m_tot = mem.get('MemTotal', 0)
m_av = mem.get('MemAvailable', mem.get('MemFree', 0))
m_used = max(0, m_tot - m_av)
s_tot = mem.get('SwapTotal', 0)
s_used = max(0, s_tot - mem.get('SwapFree', 0))

st = os.statvfs('/')
d_tot = st.f_blocks * st.f_frsize
d_av = st.f_bavail * st.f_frsize
d_used = d_tot - (st.f_bfree * st.f_frsize)
d_pct = round(d_used / (d_used + d_av) * 100.0, 1) if (d_used + d_av) else 0.0

la = [round(x, 2) for x in os.getloadavg()]
with open('/proc/uptime') as f:
    uptime = int(float(f.read().split()[0]))

procs = []
for line in run(['ps', '-eo', 'pid,user,%cpu,%mem,rss,comm', '--sort=-%cpu']).splitlines()[1:7]:
    p = line.split(None, 5)
    if len(p) == 6:
        procs.append({'pid': int(p[0]), 'user': p[1], 'cpu': float(p[2]), 'mem': float(p[3]), 'rssKb': int(p[4]), 'command': p[5][:60]})

res = {
    'hostname': run(['hostname']).strip(),
    'os': get_os(),
    'kernel': run(['uname', '-r']).strip(),
    'arch': run(['uname', '-m']).strip(),
    'cpuModel': get_cpu_model(),
    'cpuCores': os.cpu_count() or 1,
    'tailscaleIp': ts_ip,
    'disks': disks,
    'interfaces': ifaces,
    'dockerAvailable': docker_ok,
    'containersRaw': containers_raw,
    'inspectMap': inspect_map,
    'ports': ports,
    'firewall': fw,
    'systemdHighlights': svcs,
    'metrics': {
        'timestamp': int(time.time() * 1000),
        'cpuPercent': cpu_pct,
        'cpuCores': os.cpu_count() or 1,
        'loadAvg': la,
        'memTotalBytes': m_tot,
        'memUsedBytes': m_used,
        'memAvailableBytes': m_av,
        'memPercent': round(m_used / m_tot * 100.0, 1) if m_tot else 0.0,
        'swapTotalBytes': s_tot,
        'swapUsedBytes': s_used,
        'diskRootTotalBytes': d_tot,
        'diskRootUsedBytes': d_used,
        'diskRootPercent': d_pct,
        'netRxBps': round(max(0.0, (rx2 - rx1) / dt), 1),
        'netTxBps': round(max(0.0, (tx2 - tx1) / dt), 1),
        'netTotalRxBytes': rx2,
        'netTotalTxBytes': tx2,
        'netInterface': pif,
        'uptimeSeconds': uptime,
        'topProcesses': procs,
    }
}
print(json.dumps(res))
`

var (
	reDockerPort = regexp.MustCompile(`^(?:(\[?[0-9a-fA-F.:]+\]?):)?(\d+)->(\d+)/(tcp|udp)$`)
	reUnitName   = regexp.MustCompile(`^[a-zA-Z0-9_.@-]{1,80}$`)
	reUfwPort    = regexp.MustCompile(`^\d{1,5}(:\d{1,5})?$`)
	reUfwFrom    = regexp.MustCompile(`^[0-9a-fA-F.:/]{3,45}$`)
	reSSHPubKey  = regexp.MustCompile(`^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com)\s+[A-Za-z0-9+/=]{20,}(\s+.*)?$`)
)

func isNonWebPort(p int) bool {
	switch p {
	case 22, 53, 3306, 5432, 6379, 27017:
		return true
	}
	return false
}

func parseDockerPorts(portsStr, accessHost string) []DockerPort {
	results := []DockerPort{}
	if portsStr == "" {
		return results
	}
	seen := map[string]bool{}
	for _, part := range strings.Split(portsStr, ",") {
		m := reDockerPort.FindStringSubmatch(strings.TrimSpace(part))
		if m == nil {
			continue
		}
		hostIP := m[1]
		if hostIP == "" {
			hostIP = "0.0.0.0"
		}
		hostIP = strings.Trim(hostIP, "[]")
		hostPort, _ := strconv.Atoi(m[2])
		containerPort, _ := strconv.Atoi(m[3])
		proto := m[4]
		key := fmt.Sprintf("%s:%d->%d/%s", hostIP, hostPort, containerPort, proto)
		if seen[key] {
			continue
		}
		seen[key] = true
		isPublic := hostIP == "0.0.0.0" || hostIP == "::" || hostIP == "*"
		scheme := "http"
		if hostPort == 443 || hostPort == 8443 {
			scheme = "https"
		}
		quickURL := ""
		if isPublic && proto == "tcp" && !isNonWebPort(containerPort) && !isNonWebPort(hostPort) && accessHost != "" {
			if hostPort == 80 || hostPort == 443 {
				quickURL = fmt.Sprintf("%s://%s", scheme, accessHost)
			} else {
				quickURL = fmt.Sprintf("%s://%s:%d", scheme, accessHost, hostPort)
			}
		}
		results = append(results, DockerPort{
			HostIP:        hostIP,
			HostPort:      hostPort,
			ContainerPort: containerPort,
			Proto:         proto,
			IsPublic:      isPublic,
			QuickURL:      quickURL,
		})
	}
	return results
}

type dockerInspectInfo struct {
	Project string `json:"project"`
	Dir     string `json:"dir"`
	Health  string `json:"health"`
}

func buildContainersList(raw []map[string]any, inspectMap map[string]dockerInspectInfo, accessHost string) []DockerContainer {
	out := make([]DockerContainer, 0, len(raw))
	for _, c := range raw {
		fullID, _ := c["ID"].(string)
		names, _ := c["Names"].(string)
		img, _ := c["Image"].(string)
		state, _ := c["State"].(string)
		status, _ := c["Status"].(string)
		portsStr, _ := c["Ports"].(string)
		created, _ := c["CreatedAt"].(string)
		insp := inspectMap[fullID]
		shortID := fullID
		if len(shortID) > 12 {
			shortID = shortID[:12]
		}
		out = append(out, DockerContainer{
			ID:             shortID,
			Name:           strings.TrimPrefix(names, "/"),
			Image:          img,
			State:          strings.ToLower(state),
			Status:         status,
			Health:         insp.Health,
			ComposeProject: insp.Project,
			ComposeDir:     insp.Dir,
			Ports:          parseDockerPorts(portsStr, accessHost),
			CreatedAt:      created,
		})
	}
	return out
}

func enrichPortsWithContainers(ports []ListeningPort, containers []DockerContainer) []ListeningPort {
	portToContainer := map[int]string{}
	for _, c := range containers {
		for _, p := range c.Ports {
			portToContainer[p.HostPort] = c.Name
		}
	}
	out := make([]ListeningPort, len(ports))
	for i, p := range ports {
		p.DockerContainer = portToContainer[p.Port]
		out[i] = p
	}
	return out
}

func detectAutoLinks(srv ServerConfig, containers []DockerContainer, ports []ListeningPort) []QuickLink {
	existingURLs := map[string]bool{}
	existingPorts := map[int]bool{}
	for _, l := range srv.QuickLinks {
		existingURLs[strings.TrimRight(l.URL, "/")] = true
		if l.Port > 0 {
			existingPorts[l.Port] = true
		}
	}
	accessHost := firstNonEmpty(srv.PublicIP, srv.TailscaleIP, srv.Host)
	detected := []QuickLink{}

	for _, c := range containers {
		if c.State != "running" {
			continue
		}
		for _, p := range c.Ports {
			if p.QuickURL == "" || existingURLs[p.QuickURL] || existingPorts[p.HostPort] {
				continue
			}
			existingPorts[p.HostPort] = true
			imgBase := strings.Split(c.Image, ":")[0]
			parts := strings.Split(imgBase, "/")
			imgName := parts[len(parts)-1]
			detected = append(detected, QuickLink{
				ID:           fmt.Sprintf("auto-docker-%s-%d", c.Name, p.HostPort),
				Name:         c.Name,
				URL:          p.QuickURL,
				Category:     "web",
				Port:         p.HostPort,
				Description:  "Docker · " + imgName,
				AutoDetected: true,
			})
		}
	}

	webProcs := []string{"1panel-core", "x-ui", "nginx", "caddy", "openresty", "node", "python3"}
	for _, p := range ports {
		if p.Scope != "public" || !strings.HasPrefix(p.Proto, "tcp") {
			continue
		}
		if isNonWebPort(p.Port) || existingPorts[p.Port] {
			continue
		}
		proc := strings.ToLower(p.Process)
		matched := false
		for _, k := range webProcs {
			if strings.Contains(proc, k) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		scheme := "http"
		if p.Port == 443 || p.Port == 8443 {
			scheme = "https"
		}
		u := fmt.Sprintf("%s://%s:%d", scheme, accessHost, p.Port)
		if p.Port == 80 || p.Port == 443 {
			u = fmt.Sprintf("%s://%s", scheme, accessHost)
		}
		if existingURLs[u] {
			continue
		}
		existingPorts[p.Port] = true
		name := p.DockerContainer
		if name == "" {
			name = fmt.Sprintf("%s :%d", p.Process, p.Port)
		}
		cat := "web"
		if strings.Contains(proc, "panel") || strings.Contains(proc, "x-ui") {
			cat = "panel"
		}
		detected = append(detected, QuickLink{
			ID:           fmt.Sprintf("auto-port-%d", p.Port),
			Name:         name,
			URL:          u,
			Category:     cat,
			Port:         p.Port,
			Description:  fmt.Sprintf("进程 %s (%s:%d)", p.Process, p.Address, p.Port),
			AutoDetected: true,
		})
	}
	return detected
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func collectServerSnapshot(srv ServerConfig, activeJob *ActiveNQJobInfo) ServerSnapshot {
	rawLatest := getLatestNodeQualityRun(srv.ID)
	var latestNQ *NodeQualityRun
	if rawLatest != nil {
		if rawLatest.Status == "completed" {
			rep := reparseNodeQualityRun(*rawLatest, srv)
			latestNQ = &rep
		} else {
			latestNQ = rawLatest
		}
	}
	var latestSummary *LatestNQSummary
	if latestNQ != nil {
		latestSummary = &LatestNQSummary{
			ID:         latestNQ.ID,
			StartedAt:  latestNQ.StartedAt,
			FinishedAt: latestNQ.FinishedAt,
			Mode:       latestNQ.Mode,
			Status:     latestNQ.Status,
			ReportURL:  latestNQ.ReportURL,
			Summary:    latestNQ.Summary,
		}
	}

	nowStr := time.Now().UTC().Format(time.RFC3339)
	offlineSnap := func(errMsg string) ServerSnapshot {
		return ServerSnapshot{
			Server:               srv,
			Online:               false,
			Error:                errMsg,
			PublicIP:             srv.PublicIP,
			TailscaleIP:          srv.TailscaleIP,
			Disks:                []DiskMount{},
			Interfaces:           []NetInterface{},
			DockerAvailable:      false,
			ContainersPreview:    []DockerContainer{},
			SystemdHighlights:    []SystemdService{},
			FirewallSummary:      FirewallSummary{Engine: "unknown"},
			PublicPortsPreview:   []ListeningPort{},
			ComposeDirs:          []ComposeDirInfo{},
			DetectedLinks:        []QuickLink{},
			LatestNodeQuality:    latestSummary,
			ActiveNodeQualityJob: activeJob,
			CollectedAt:          nowStr,
		}
	}

	res, err := execScript(srv, "python3 - <<'PYEOF'\n"+snapshotPy+"\nPYEOF\n", ExecOpts{
		Timeout: 14 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return offlineSnap(err.Error())
	}

	var raw struct {
		Hostname          string                       `json:"hostname"`
		OS                string                       `json:"os"`
		Kernel            string                       `json:"kernel"`
		Arch              string                       `json:"arch"`
		CPUModel          string                       `json:"cpuModel"`
		CPUCores          int                          `json:"cpuCores"`
		TailscaleIP       string                       `json:"tailscaleIp"`
		Disks             []DiskMount                  `json:"disks"`
		Interfaces        []NetInterface               `json:"interfaces"`
		DockerAvailable   bool                         `json:"dockerAvailable"`
		ContainersRaw     []map[string]any             `json:"containersRaw"`
		InspectMap        map[string]dockerInspectInfo `json:"inspectMap"`
		Ports             []ListeningPort              `json:"ports"`
		Firewall          struct {
			Engine string `json:"engine"`
			Active bool   `json:"active"`
		} `json:"firewall"`
		SystemdHighlights []SystemdService `json:"systemdHighlights"`
		Metrics           *LiveMetrics     `json:"metrics"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &raw); err != nil {
		return offlineSnap("解析快照失败: " + err.Error())
	}

	accessHost := firstNonEmpty(srv.PublicIP, raw.TailscaleIP, srv.TailscaleIP, srv.Host)
	containers := buildContainersList(raw.ContainersRaw, raw.InspectMap, accessHost)
	enrichedPorts := enrichPortsWithContainers(raw.Ports, containers)

	running, unhealthy := 0, 0
	composeMap := map[string]string{}
	composeDirs := []ComposeDirInfo{}
	for _, c := range containers {
		if c.State == "running" {
			running++
		}
		if c.Health == "unhealthy" {
			unhealthy++
		}
		if c.ComposeProject != "" && c.ComposeDir != "" {
			if _, ok := composeMap[c.ComposeProject]; !ok {
				composeMap[c.ComposeProject] = c.ComposeDir
				composeDirs = append(composeDirs, ComposeDirInfo{Project: c.ComposeProject, Dir: c.ComposeDir})
			}
		}
	}

	publicPorts := []ListeningPort{}
	tsCount, localCount := 0, 0
	for _, p := range enrichedPorts {
		if p.Scope == "public" && strings.HasPrefix(p.Proto, "tcp") {
			publicPorts = append(publicPorts, p)
		} else if p.Scope == "tailscale" {
			tsCount++
		} else if p.Scope == "local" {
			localCount++
		}
	}
	sort.Slice(publicPorts, func(i, j int) bool { return publicPorts[i].Port < publicPorts[j].Port })

	if raw.Disks == nil {
		raw.Disks = []DiskMount{}
	}
	if raw.Interfaces == nil {
		raw.Interfaces = []NetInterface{}
	}
	for i := range raw.Interfaces {
		if raw.Interfaces[i].IPv4 == nil {
			raw.Interfaces[i].IPv4 = []string{}
		}
		if raw.Interfaces[i].IPv6 == nil {
			raw.Interfaces[i].IPv6 = []string{}
		}
	}
	if raw.SystemdHighlights == nil {
		raw.SystemdHighlights = []SystemdService{}
	}
	if raw.Metrics != nil && raw.Metrics.TopProcesses == nil {
		raw.Metrics.TopProcesses = []ProcessMetric{}
	}

	nqIP := ""
	if latestNQ != nil {
		nqIP = latestNQ.Summary.IP.IPv4
	}
	fwEngine := raw.Firewall.Engine
	if fwEngine == "" {
		fwEngine = "iptables"
	}

	return ServerSnapshot{
		Server:          srv,
		Online:          true,
		Hostname:        raw.Hostname,
		OS:              raw.OS,
		Kernel:          raw.Kernel,
		Arch:            raw.Arch,
		CPUModel:        raw.CPUModel,
		CPUCores:        raw.CPUCores,
		PublicIP:        firstNonEmpty(srv.PublicIP, nqIP, srv.Host),
		TailscaleIP:     firstNonEmpty(raw.TailscaleIP, srv.TailscaleIP),
		Metrics:         raw.Metrics,
		Disks:           raw.Disks,
		Interfaces:      raw.Interfaces,
		DockerAvailable: raw.DockerAvailable,
		DockerSummary: DockerSummary{
			Total:     len(containers),
			Running:   running,
			Stopped:   len(containers) - running,
			Unhealthy: unhealthy,
		},
		ContainersPreview: containers,
		SystemdHighlights: raw.SystemdHighlights,
		FirewallSummary: FirewallSummary{
			Engine:              fwEngine,
			Active:              raw.Firewall.Active,
			PublicPortsCount:    len(publicPorts),
			TailscalePortsCount: tsCount,
			LocalPortsCount:     localCount,
		},
		PublicPortsPreview:   publicPorts,
		ComposeDirs:          composeDirs,
		DetectedLinks:        detectAutoLinks(srv, containers, enrichedPorts),
		LatestNodeQuality:    latestSummary,
		ActiveNodeQualityJob: activeJob,
		NetworkSummary:       getServerNetworkBrief(srv.ID),
		CollectedAt:          nowStr,
	}
}

const servicesDetailPy = `
import json, shutil, subprocess

def run(cmd, timeout=10):
    try:
        return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=timeout).stdout
    except Exception:
        return ''

docker_ok = bool(shutil.which('docker'))
containers_raw = []
inspect_map = {}
stats_map = {}

if docker_ok:
    ids = []
    for line in run(['docker', 'ps', '-a', '--no-trunc', '--format', '{{json .}}']).splitlines():
        if not line.strip(): continue
        try:
            c = json.loads(line)
            containers_raw.append(c)
            ids.append(c.get('ID', ''))
        except Exception:
            pass
    if ids:
        insp = run(['docker', 'inspect', '--format', '{{.Id}}\t{{index .Config.Labels "com.docker.compose.project"}}\t{{index .Config.Labels "com.docker.compose.project.working_dir"}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}'] + ids)
        for line in insp.splitlines():
            p = line.split('\t')
            if len(p) >= 4:
                inspect_map[p[0]] = {'project': p[1], 'dir': p[2], 'health': p[3]}
        st = run(['docker', 'stats', '--no-stream', '--no-trunc', '--format', '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}'], timeout=12)
        for line in st.splitlines():
            p = line.split('\t')
            if len(p) >= 5:
                stats_map[p[0]] = {'cpu': p[1], 'memUsage': p[2], 'memPerc': p[3], 'netIO': p[4]}

svcs = []
seen = set()
skip = ('systemd-', 'dbus', 'getty', 'serial-getty', 'user@', 'polkit', 'udisks', 'ModemManager', 'networkd-', 'unattended-', 'multipathd', 'irqbalance', 'packagekit', 'fwupd', 'accounts-', 'avahi-', 'acpid', 'atd', 'cloud-init', 'chrony', 'auditd', 'rsyslog', 'rpcbind', 'snapd', 'console-', 'plymouth', 'networking', 'ufw', 'apparmor', 'e2scrub', 'fstrim', 'logrotate', 'man-db', 'apt-', 'dpkg-', 'motd-', 'ua-', 'ubuntu-', 'sysstat', 'setvtrgb', 'kmod', 'keyboard-', 'blk-availability', 'lvm2-', 'dm-', 'multipath', 'finalrd', 'grub-', 'rc-local', 'ondemand', 'irqbalance', 'qemu-guest-agent')
for line in run(['systemctl', 'list-units', '--type=service', '--state=running,failed', '--no-pager', '--no-legend', '--plain']).splitlines():
    p = line.split(None, 4)
    if len(p) < 5: continue
    name, _, active, sub, desc = p
    if any(name.startswith(s) for s in skip) or '@' in name: continue
    short = name.replace('.service', '')
    seen.add(short)
    svcs.append({'name': short, 'description': desc, 'activeState': active, 'subState': sub})

# Also include stopped custom/enabled services so users can start them back up
import os
cand_units = []
try:
    for fn in sorted(os.listdir('/etc/systemd/system')):
        if not fn.endswith('.service') or '@' in fn: continue
        if any(fn.startswith(s) for s in skip): continue
        short = fn[:-8]
        if short not in seen:
            cand_units.append(short)
except Exception:
    pass
for line in run(['systemctl', 'list-unit-files', '--type=service', '--state=enabled', '--no-pager', '--no-legend']).splitlines():
    p = line.split()
    if not p: continue
    fn = p[0]
    if not fn.endswith('.service') or '@' in fn: continue
    if any(fn.startswith(s) for s in skip): continue
    short = fn[:-8]
    if short not in seen and short not in cand_units:
        cand_units.append(short)

for short in cand_units[:30]:
    info = run(['systemctl', 'show', short + '.service', '--property=ActiveState,SubState,Description,Type,LoadState', '--no-pager'])
    kv = {}
    for ln in info.splitlines():
        if '=' in ln:
            k, v = ln.split('=', 1)
            kv[k] = v
    if kv.get('LoadState') != 'loaded': continue
    if kv.get('Type') == 'oneshot': continue
    act = kv.get('ActiveState', 'inactive')
    if act == 'active': continue
    seen.add(short)
    svcs.append({
        'name': short,
        'description': kv.get('Description', '') or short,
        'activeState': act,
        'subState': kv.get('SubState', 'dead'),
    })

print(json.dumps({'dockerAvailable': docker_ok, 'containersRaw': containers_raw, 'inspectMap': inspect_map, 'statsMap': stats_map, 'systemdServices': svcs}))
`

type ServicesDetailResult struct {
	DockerAvailable bool              `json:"dockerAvailable"`
	Containers      []DockerContainer `json:"containers"`
	SystemdServices []SystemdService  `json:"systemdServices"`
}

func collectServicesDetail(srv ServerConfig) (ServicesDetailResult, error) {
	res, err := execScript(srv, "python3 - <<'PYEOF'\n"+servicesDetailPy+"\nPYEOF\n", ExecOpts{
		Timeout: 18 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return ServicesDetailResult{}, err
	}
	var raw struct {
		DockerAvailable bool                         `json:"dockerAvailable"`
		ContainersRaw   []map[string]any             `json:"containersRaw"`
		InspectMap      map[string]dockerInspectInfo `json:"inspectMap"`
		StatsMap        map[string]struct {
			CPU      string `json:"cpu"`
			MemUsage string `json:"memUsage"`
			MemPerc  string `json:"memPerc"`
			NetIO    string `json:"netIO"`
		} `json:"statsMap"`
		SystemdServices []SystemdService `json:"systemdServices"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &raw); err != nil {
		return ServicesDetailResult{}, err
	}
	accessHost := firstNonEmpty(srv.PublicIP, srv.TailscaleIP, srv.Host)
	containers := buildContainersList(raw.ContainersRaw, raw.InspectMap, accessHost)
	for i := range containers {
		for k, st := range raw.StatsMap {
			if strings.HasPrefix(k, containers[i].ID) {
				cpuV, _ := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(st.CPU), "%"), 64)
				memV, _ := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(st.MemPerc), "%"), 64)
				containers[i].CPUPercent = &cpuV
				containers[i].MemUsage = st.MemUsage
				containers[i].MemPercent = &memV
				containers[i].NetIO = st.NetIO
				break
			}
		}
	}
	if raw.SystemdServices == nil {
		raw.SystemdServices = []SystemdService{}
	}
	return ServicesDetailResult{
		DockerAvailable: raw.DockerAvailable,
		Containers:      containers,
		SystemdServices: raw.SystemdServices,
	}, nil
}

func runDockerAction(srv ServerConfig, containerID, action string) (string, error) {
	if !reContainerName.MatchString(containerID) {
		return "", errors.New("非法的容器标识")
	}
	res, err := execScript(srv, `docker "$1" "$2"`, ExecOpts{
		Args:    []string{action, containerID},
		Timeout: 30 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return "", err
	}
	if res.Code != 0 {
		msg := strings.TrimSpace(res.Stderr)
		if msg == "" {
			msg = "docker " + action + " failed"
		}
		return "", errors.New(msg)
	}
	return strings.TrimSpace(res.Stdout), nil
}

func runDockerRemove(srv ServerConfig, containerID string, removeVolumes bool) (string, error) {
	if !reContainerName.MatchString(containerID) {
		return "", errors.New("非法的容器标识")
	}
	script := `docker rm -f "$1"`
	if removeVolumes {
		script = `docker rm -f -v "$1"`
	}
	res, err := execScript(srv, script, ExecOpts{
		Args:    []string{containerID},
		Timeout: 30 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return "", err
	}
	if res.Code != 0 {
		msg := strings.TrimSpace(res.Stderr)
		if msg == "" {
			msg = "docker rm failed"
		}
		return "", errors.New(msg)
	}
	return strings.TrimSpace(res.Stdout), nil
}

func getDockerLogs(srv ServerConfig, containerID string, tail int) (string, error) {
	if !reContainerName.MatchString(containerID) {
		return "", errors.New("非法的容器标识")
	}
	tail = clampInt(tail, 150, 10, 1000)
	res, err := execScript(srv, `docker logs --tail "$1" --timestamps "$2" 2>&1`, ExecOpts{
		Args:    []string{strconv.Itoa(tail), containerID},
		Timeout: 15 * time.Second,
		Sudo:    true,
	})
	return res.Stdout, err
}

func getSystemdLogs(srv ServerConfig, unit string, lines int) (string, error) {
	if !reUnitName.MatchString(unit) {
		return "", errors.New("非法的服务名")
	}
	lines = clampInt(lines, 120, 10, 500)
	res, err := execScript(srv, `journalctl -u "$1" -n "$2" --no-pager 2>&1`, ExecOpts{
		Args:    []string{unit, strconv.Itoa(lines)},
		Timeout: 12 * time.Second,
		Sudo:    true,
	})
	return res.Stdout, err
}

func runSystemdAction(srv ServerConfig, unit, action string) error {
	if !reUnitName.MatchString(unit) {
		return errors.New("非法的服务名")
	}
	if action == "stop" && (unit == "ssh" || unit == "sshd" || unit == "atlasnode" || unit == "tailscaled") {
		return fmt.Errorf("出于安全保护，禁止通过面板停止关键服务 %s", unit)
	}
	res, err := execScript(srv, `systemctl "$1" "$2"`, ExecOpts{
		Args:    []string{action, unit},
		Timeout: 20 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return err
	}
	if res.Code != 0 {
		msg := strings.TrimSpace(res.Stderr)
		if msg == "" {
			msg = "systemctl " + action + " failed"
		}
		return errors.New(msg)
	}
	return nil
}

const firewallPy = `
import json, re, shutil, subprocess

def run(cmd, timeout=6):
    try:
        return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=timeout).stdout
    except Exception:
        return ''

engine = 'iptables'
active = False
default_in = 'unknown'
default_out = 'unknown'
ufw_rules = []

if shutil.which('ufw'):
    engine = 'ufw'
    verbose = run(['ufw', 'status', 'verbose'])
    active = 'Status: active' in verbose
    m = re.search(r'Default:\s+(\w+)\s+\(incoming\),\s+(\w+)\s+\(outgoing\)', verbose)
    if m:
        default_in, default_out = m.group(1), m.group(2)
    numbered = run(['ufw', 'status', 'numbered'])
    for line in numbered.splitlines():
        m = re.match(r'^\[\s*(\d+)\]\s+(.+?)\s+(ALLOW|DENY|REJECT|LIMIT)\s+(?:IN|OUT|FWD)?\s*(.+)$', line.strip())
        if m:
            num = int(m.group(1))
            to_part = m.group(2).strip()
            action = m.group(3).strip()
            rest = m.group(4).strip()
            comment = ''
            if '#' in rest:
                rest, comment = rest.split('#', 1)
                rest = rest.strip()
                comment = comment.strip()
            ufw_rules.append({
                'num': num,
                'to': to_part,
                'action': action,
                'from': rest,
                'comment': comment or '',
                'ipv6': '(v6)' in to_part or '(v6)' in rest,
            })

docker_ports = {}
if shutil.which('docker'):
    for line in run(['docker', 'ps', '--format', '{{.Names}}\t{{.Ports}}']).splitlines():
        if '\t' not in line: continue
        name, pstr = line.split('\t', 1)
        for m in re.finditer(r':(\d+)->', pstr):
            docker_ports[int(m.group(1))] = name

ports = []
seen = set()
for line in run(['ss', '-tulnp']).splitlines()[1:]:
    parts = line.split()
    if len(parts) < 5: continue
    proto, state, local = parts[0], parts[1], parts[4]
    if proto.startswith('tcp') and state != 'LISTEN': continue
    if ':' not in local: continue
    idx = local.rfind(':')
    addr = local[:idx].strip('[]').split('%', 1)[0]
    try:
        port = int(local[idx+1:])
    except Exception:
        continue
    proc, pid = 'unknown', None
    rest = ' '.join(parts[6:]) if len(parts) > 6 else ''
    m = re.search(r'"([^"]+)",pid=(\d+)', rest)
    if m:
        proc, pid = m.group(1), int(m.group(2))
    key = (proto, addr, port, proc)
    if key in seen: continue
    seen.add(key)
    if addr in ('0.0.0.0', '*', '::'):
        scope = 'public'
    elif addr.startswith('100.'):
        scope = 'tailscale'
    elif addr.startswith('127.') or addr == '::1':
        scope = 'local'
    else:
        scope = 'private'
    ports.append({
        'proto': proto,
        'address': addr,
        'port': port,
        'scope': scope,
        'process': proc,
        'pid': pid,
        'dockerContainer': docker_ports.get(port, ''),
    })

raw_ipt = ''
nft_handles = ''
if not active and shutil.which('nft'):
    nft_out = run(['nft', '-a', 'list', 'ruleset'])
    if 'hook input' in nft_out and ('drop' in nft_out or 'reject' in nft_out):
        engine = 'nftables'
        active = True
        default_in = 'drop (nftables)'
        default_out = 'accept'
        raw_ipt = nft_out[:16000]
        nft_handles = nft_out[:24000]

if not raw_ipt:
    raw_ipt = run(['iptables', '-L', 'INPUT', '-n', '-v', '--line-numbers'])
    if shutil.which('nft'):
        nft_out = run(['nft', '-a', 'list', 'ruleset'])
        if nft_out:
            nft_handles = nft_out[:24000]
            raw_ipt = (raw_ipt + '\n\n=== nftables ===\n' + nft_out)[:16000]

print(json.dumps({
    'engine': engine,
    'active': active,
    'defaultIncoming': default_in,
    'defaultOutgoing': default_out,
    'ufwRules': ufw_rules,
    'listeningPorts': sorted(ports, key=lambda x: ({'public':0,'tailscale':1,'private':2,'local':3}[x['scope']], x['port'])),
    'rawIptables': raw_ipt[:16000],
    'nftHandlesRaw': nft_handles,
}))
`

func collectFirewall(srv ServerConfig) (FirewallData, error) {
	res, err := execScript(srv, "python3 - <<'PYEOF'\n"+firewallPy+"\nPYEOF\n", ExecOpts{
		Timeout: 14 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return FirewallData{}, err
	}
	var parsed struct {
		FirewallData
		NftHandlesRaw string `json:"nftHandlesRaw"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &parsed); err != nil {
		return FirewallData{}, err
	}
	fw := parsed.FirewallData
	if fw.UfwRules == nil {
		fw.UfwRules = []UfwRule{}
	}
	if fw.ListeningPorts == nil {
		fw.ListeningPorts = []ListeningPort{}
	}
	if parsed.NftHandlesRaw != "" {
		rules, target := parseNftRulesFromText(parsed.NftHandlesRaw)
		fw.NftRules = rules
		fw.NftTarget = target
	}
	return fw, nil
}

func addUfwRule(srv ServerConfig, port, proto, action, from, comment string) (string, error) {
	if !reUfwPort.MatchString(port) {
		return "", errors.New("端口格式不正确（例如 8080 或 8000:8100）")
	}
	if action != "allow" && action != "deny" && action != "limit" {
		return "", errors.New("非法规则动作")
	}
	if port == "22" && action == "deny" {
		return "", errors.New("禁止直接封禁 SSH 22 端口，避免失联")
	}
	from = strings.TrimSpace(from)
	if from == "" {
		from = "any"
	}
	if from != "any" && !reUfwFrom.MatchString(from) {
		return "", errors.New("来源 IP / CIDR 格式不正确")
	}
	comment = reSafeComm.ReplaceAllString(comment, "")
	if runes := []rune(comment); len(runes) > 48 {
		comment = string(runes[:48])
	}
	portSpec := port
	if proto == "tcp" || proto == "udp" {
		portSpec = port + "/" + proto
	}

	script := `
ACTION="$1"
PORT_SPEC="$2"
FROM_IP="$3"
COMMENT="$4"
if [ "$FROM_IP" = "any" ]; then
  if [ -n "$COMMENT" ]; then
    ufw "$ACTION" "$PORT_SPEC" comment "$COMMENT"
  else
    ufw "$ACTION" "$PORT_SPEC"
  fi
else
  PORT_NUM="${PORT_SPEC%%/*}"
  PROTO="${PORT_SPEC#*/}"
  if [ "$PROTO" != "$PORT_SPEC" ]; then
    if [ -n "$COMMENT" ]; then
      ufw "$ACTION" from "$FROM_IP" to any port "$PORT_NUM" proto "$PROTO" comment "$COMMENT"
    else
      ufw "$ACTION" from "$FROM_IP" to any port "$PORT_NUM" proto "$PROTO"
    fi
  else
    if [ -n "$COMMENT" ]; then
      ufw "$ACTION" from "$FROM_IP" to any port "$PORT_NUM" comment "$COMMENT"
    else
      ufw "$ACTION" from "$FROM_IP" to any port "$PORT_NUM"
    fi
  fi
fi
`
	res, err := execScript(srv, script, ExecOpts{
		Args:    []string{action, portSpec, from, comment},
		Timeout: 12 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return "", err
	}
	if res.Code != 0 {
		msg := firstNonEmpty(res.Stderr, res.Stdout, "添加规则失败")
		return "", errors.New(msg)
	}
	return strings.TrimSpace(res.Stdout), nil
}

func deleteUfwRule(srv ServerConfig, ruleNum int) (string, error) {
	if ruleNum < 1 || ruleNum > 500 {
		return "", errors.New("非法的规则编号")
	}
	res, err := execScript(srv, `yes | ufw delete "$1"`, ExecOpts{
		Args:    []string{strconv.Itoa(ruleNum)},
		Timeout: 12 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return "", err
	}
	if res.Code != 0 {
		return "", errors.New(firstNonEmpty(res.Stderr, res.Stdout, "删除规则失败"))
	}
	return strings.TrimSpace(res.Stdout), nil
}

func toggleUfw(srv ServerConfig, enable bool) (string, error) {
	script := "ufw disable"
	if enable {
		script = `ufw allow 22/tcp comment 'SSH' >/dev/null 2>&1 || true; ufw --force enable`
	}
	res, err := execScript(srv, script, ExecOpts{Timeout: 12 * time.Second, Sudo: true})
	if err != nil {
		return "", err
	}
	if res.Code != 0 {
		return "", errors.New(firstNonEmpty(res.Stderr, res.Stdout, "切换 UFW 失败"))
	}
	return strings.TrimSpace(res.Stdout), nil
}

func normalizeRemotePath(input string) string {
	cleaned := strings.TrimSpace(strings.ReplaceAll(input, "\x00", ""))
	if cleaned == "" {
		return "/"
	}
	if !strings.HasPrefix(cleaned, "/") {
		return "/" + cleaned
	}
	return cleaned
}

const listDirPy = `
import datetime, grp, json, os, pwd, stat, sys

target = os.path.realpath(sys.argv[1]) if os.path.exists(sys.argv[1]) else sys.argv[1]
if not os.path.isdir(target):
    print(json.dumps({'error': f'目录不存在或不可访问: {target}'}))
    sys.exit(0)

entries = []
for name in sorted(os.listdir(target), key=lambda x: (not os.path.isdir(os.path.join(target, x)), x.lower())):
    full = os.path.join(target, name)
    try:
        st = os.lstat(full)
        is_link = stat.S_ISLNK(st.st_mode)
        is_dir = os.path.isdir(full)
        try:
            owner = pwd.getpwuid(st.st_uid).pw_name
        except Exception:
            owner = str(st.st_uid)
        try:
            group = grp.getgrgid(st.st_gid).gr_name
        except Exception:
            group = str(st.st_gid)
        entries.append({
            'name': name,
            'path': full,
            'isDir': is_dir,
            'isSymlink': is_link,
            'size': st.st_size,
            'mode': stat.filemode(st.st_mode),
            'owner': owner,
            'group': group,
            'mtime': datetime.datetime.fromtimestamp(st.st_mtime, datetime.timezone.utc).isoformat(),
        })
    except Exception:
        pass

print(json.dumps({'path': target, 'entries': entries}))
`

func listDirectory(srv ServerConfig, dirPath string) (string, []FileEntry, error) {
	target := normalizeRemotePath(dirPath)
	res, err := execScript(srv, "python3 - \"$1\" <<'PYEOF'\n"+listDirPy+"\nPYEOF\n", ExecOpts{
		Args:    []string{target},
		Timeout: 12 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return "", nil, err
	}
	var parsed struct {
		Path    string      `json:"path"`
		Entries []FileEntry `json:"entries"`
		Error   string      `json:"error"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &parsed); err != nil {
		return "", nil, err
	}
	if parsed.Error != "" {
		return "", nil, errors.New(parsed.Error)
	}
	if parsed.Entries == nil {
		parsed.Entries = []FileEntry{}
	}
	if parsed.Path == "" {
		parsed.Path = target
	}
	return parsed.Path, parsed.Entries, nil
}

const readPreviewPy = `
import json, os, sys

p = sys.argv[1]
if not os.path.isfile(p):
    print(json.dumps({'error': '文件不存在'}))
    sys.exit(0)
size = os.path.getsize(p)
limit = 512 * 1024
with open(p, 'rb') as f:
    data = f.read(limit)
truncated = size > limit
if b'\x00' in data[:4096]:
    print(json.dumps({'path': p, 'size': size, 'truncated': truncated, 'binary': True, 'content': ''}))
    sys.exit(0)
text = data.decode('utf-8', errors='replace')
print(json.dumps({'path': p, 'size': size, 'truncated': truncated, 'binary': False, 'content': text}))
`

func readFilePreview(srv ServerConfig, filePath string) (FilePreview, error) {
	target := normalizeRemotePath(filePath)
	res, err := execScript(srv, "python3 - \"$1\" <<'PYEOF'\n"+readPreviewPy+"\nPYEOF\n", ExecOpts{
		Args:    []string{target},
		Timeout: 12 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return FilePreview{}, err
	}
	var parsed struct {
		FilePreview
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &parsed); err != nil {
		return FilePreview{}, err
	}
	if parsed.Error != "" {
		return FilePreview{}, errors.New(parsed.Error)
	}
	return parsed.FilePreview, nil
}

func writeFileContent(srv ServerConfig, filePath, content string) error {
	target := normalizeRemotePath(filePath)
	return writeRemoteStream(srv, target, strings.NewReader(content))
}

func uploadFileBase64(srv ServerConfig, filePath, b64 string) error {
	target := normalizeRemotePath(filePath)
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil {
		return errors.New("无效的 Base64 文件内容")
	}
	return writeRemoteStream(srv, target, strings.NewReader(string(raw)))
}

func createRemoteDirectory(srv ServerConfig, dirPath string) error {
	target := normalizeRemotePath(dirPath)
	res, err := execScript(srv, `mkdir -p "$1"`, ExecOpts{
		Args:    []string{target},
		Timeout: 10 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return err
	}
	if res.Code != 0 {
		return errors.New(firstNonEmpty(res.Stderr, "创建目录失败"))
	}
	return nil
}

func deleteRemotePath(srv ServerConfig, targetPath string) error {
	target := normalizeRemotePath(targetPath)
	trimmed := strings.TrimRight(target, "/")
	if trimmed == "" {
		trimmed = "/"
	}
	forbidden := map[string]bool{
		"/": true, "/root": true, "/home": true, "/etc": true, "/usr": true,
		"/var": true, "/bin": true, "/sbin": true, "/lib": true, "/opt": true,
		"/boot": true, "/dev": true, "/proc": true, "/sys": true,
	}
	if forbidden[trimmed] {
		return fmt.Errorf("禁止删除系统受保护路径: %s", target)
	}
	res, err := execScript(srv, `rm -rf -- "$1"`, ExecOpts{
		Args:    []string{target},
		Timeout: 12 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return err
	}
	if res.Code != 0 {
		return errors.New(firstNonEmpty(res.Stderr, "删除失败"))
	}
	return nil
}

const collectKeysPy = `
import json, os, pwd, subprocess, sys

user = sys.argv[1]
manager_body = sys.argv[2]
try:
    home = pwd.getpwnam(user).pw_dir
except Exception:
    home = os.path.expanduser('~')

auth_file = os.path.join(home, '.ssh', 'authorized_keys')
keys = []
if os.path.isfile(auth_file):
    with open(auth_file, 'r', errors='replace') as f:
        for idx, raw in enumerate(f.readlines()):
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            ktype = parts[0]
            kbody = parts[1]
            comment = ' '.join(parts[2:]) if len(parts) > 2 else ''
            fp = ''
            try:
                r = subprocess.run(['ssh-keygen', '-lf', '-'], input=line, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3)
                fp_parts = r.stdout.strip().split()
                if len(fp_parts) >= 2:
                    fp = fp_parts[1]
            except Exception:
                pass
            keys.append({
                'index': idx,
                'type': ktype,
                'key': kbody,
                'comment': comment,
                'fingerprint': fp,
                'isManagerKey': bool(manager_body and kbody == manager_body),
                'rawLine': line,
            })

sshd_cfg = {'port': '22', 'permitRootLogin': 'unknown', 'passwordAuthentication': 'unknown', 'pubkeyAuthentication': 'unknown'}
try:
    r = subprocess.run(['sshd', '-T'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=4)
    for line in r.stdout.splitlines():
        p = line.strip().split(None, 1)
        if len(p) != 2: continue
        k, v = p[0].lower(), p[1]
        if k == 'port': sshd_cfg['port'] = v
        elif k == 'permitrootlogin': sshd_cfg['permitRootLogin'] = v
        elif k == 'passwordauthentication': sshd_cfg['passwordAuthentication'] = v
        elif k == 'pubkeyauthentication': sshd_cfg['pubkeyAuthentication'] = v
except Exception:
    pass

logins = []
try:
    r = subprocess.run(['last', '-n', '8', '-w'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=4)
    for line in r.stdout.splitlines():
        s = line.strip()
        if s and not s.startswith('wtmp begins'):
            logins.append(s)
except Exception:
    pass

print(json.dumps({
    'targetFile': auth_file,
    'keys': keys,
    'sshdConfig': sshd_cfg,
    'recentLogins': logins[:8],
}))
`

func managerKeyBody() string {
	fields := strings.Fields(getManagerPublicKey())
	if len(fields) >= 2 {
		return fields[1]
	}
	return ""
}

func collectSshKeys(srv ServerConfig) (SshSecurityInfo, error) {
	res, err := execScript(srv, "python3 - \"$1\" \"$2\" <<'PYEOF'\n"+collectKeysPy+"\nPYEOF\n", ExecOpts{
		Args:    []string{srv.Username, managerKeyBody()},
		Timeout: 12 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return SshSecurityInfo{}, err
	}
	var info SshSecurityInfo
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &info); err != nil {
		return SshSecurityInfo{}, err
	}
	if info.Keys == nil {
		info.Keys = []SshKeyItem{}
	}
	if info.RecentLogins == nil {
		info.RecentLogins = []string{}
	}
	info.ManagerPublicKey = getManagerPublicKey()
	return info, nil
}

const addKeyPy = `
import os, pwd, sys
user = sys.argv[1]
pub = sys.argv[2].strip()
pw = pwd.getpwnam(user)
ssh_dir = os.path.join(pw.pw_dir, '.ssh')
os.makedirs(ssh_dir, mode=0o700, exist_ok=True)
auth_file = os.path.join(ssh_dir, 'authorized_keys')
existing = []
if os.path.isfile(auth_file):
    with open(auth_file, 'r', errors='replace') as f:
        existing = [l.strip() for l in f.readlines()]
key_body = pub.split()[1]
for line in existing:
    parts = line.split()
    if len(parts) >= 2 and parts[1] == key_body:
        print('EXISTS')
        sys.exit(0)
with open(auth_file, 'a') as f:
    if existing and existing[-1] != '':
        f.write('\n')
    f.write(pub + '\n')
os.chmod(auth_file, 0o600)
try:
    os.chown(ssh_dir, pw.pw_uid, pw.pw_gid)
    os.chown(auth_file, pw.pw_uid, pw.pw_gid)
except Exception:
    pass
print('ADDED')
`

func addSshKey(srv ServerConfig, publicKey string) error {
	cleaned := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(publicKey, "\r\n", " "), "\n", " "))
	if !reSSHPubKey.MatchString(cleaned) {
		return errors.New("公钥格式无效，请提供标准的 OpenSSH 公钥（如 ssh-ed25519 AAAA...）")
	}
	res, err := execScript(srv, "python3 - \"$1\" \"$2\" <<'PYEOF'\n"+addKeyPy+"\nPYEOF\n", ExecOpts{
		Args:    []string{srv.Username, cleaned},
		Timeout: 10 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return err
	}
	if res.Code != 0 {
		return errors.New(firstNonEmpty(res.Stderr, "添加公钥失败"))
	}
	if strings.Contains(res.Stdout, "EXISTS") {
		return errors.New("该公钥已存在")
	}
	return nil
}

const removeKeyPy = `
import os, pwd, sys
user = sys.argv[1]
idx = int(sys.argv[2])
manager_body = sys.argv[3]
pw = pwd.getpwnam(user)
auth_file = os.path.join(pw.pw_dir, '.ssh', 'authorized_keys')
with open(auth_file, 'r', errors='replace') as f:
    lines = f.readlines()
if idx < 0 or idx >= len(lines):
    sys.stderr.write('无效的公钥索引\n')
    sys.exit(1)
target = lines[idx].strip()
parts = target.split()
if len(parts) >= 2 and manager_body and parts[1] == manager_body:
    sys.stderr.write('禁止删除当前 AtlasNode 管理公钥，以免失联\n')
    sys.exit(1)
del lines[idx]
with open(auth_file, 'w') as f:
    f.writelines(lines)
os.chmod(auth_file, 0o600)
`

func removeSshKey(srv ServerConfig, lineIndex int) error {
	res, err := execScript(srv, "python3 - \"$1\" \"$2\" \"$3\" <<'PYEOF'\n"+removeKeyPy+"\nPYEOF\n", ExecOpts{
		Args:    []string{srv.Username, strconv.Itoa(lineIndex), managerKeyBody()},
		Timeout: 10 * time.Second,
		Sudo:    true,
	})
	if err != nil {
		return err
	}
	if res.Code != 0 {
		return errors.New(firstNonEmpty(res.Stderr, "删除公钥失败"))
	}
	return nil
}

func discoverTailscalePeers(servers []ServerConfig) (string, []TailscalePeer) {
	existingIPs := map[string]bool{}
	for _, s := range servers {
		for _, ip := range []string{s.Host, s.TailscaleIP, s.PublicIP} {
			if ip != "" {
				existingIPs[ip] = true
			}
		}
	}
	cands := append([]ServerConfig{}, servers...)
	sort.SliceStable(cands, func(i, j int) bool {
		return cands[i].Mode == "local" && cands[j].Mode != "local"
	})

	type tsNode struct {
		ID           string   `json:"ID"`
		HostName     string   `json:"HostName"`
		DNSName      string   `json:"DNSName"`
		TailscaleIPs []string `json:"TailscaleIPs"`
		OS           string   `json:"OS"`
		Online       bool     `json:"Online"`
		LastSeen     string   `json:"LastSeen"`
	}

	for _, c := range cands {
		res, err := execScript(c, `tailscale status --json 2>/dev/null`, ExecOpts{Timeout: 7 * time.Second})
		if err != nil || res.Code != 0 || strings.TrimSpace(res.Stdout) == "" {
			continue
		}
		var data struct {
			BackendState string            `json:"BackendState"`
			Self         *tsNode           `json:"Self"`
			Peer         map[string]tsNode `json:"Peer"`
		}
		if json.Unmarshal([]byte(res.Stdout), &data) != nil || data.Self == nil || data.BackendState != "Running" {
			continue
		}
		peers := []TailscalePeer{}
		addNode := func(n tsNode) {
			ip := ""
			for _, x := range n.TailscaleIPs {
				if strings.Contains(x, ".") {
					ip = x
					break
				}
			}
			if ip == "" && len(n.TailscaleIPs) > 0 {
				ip = n.TailscaleIPs[0]
			}
			if ip == "" {
				return
			}
			id := n.ID
			if id == "" {
				id = ip
			}
			hn := n.HostName
			if hn == "" {
				hn = ip
			}
			osName := n.OS
			if osName == "" {
				osName = "unknown"
			}
			peers = append(peers, TailscalePeer{
				ID:           id,
				HostName:     hn,
				DNSName:      strings.TrimSuffix(n.DNSName, "."),
				TailscaleIP:  ip,
				OS:           osName,
				Online:       n.Online,
				LastSeen:     n.LastSeen,
				AlreadyAdded: existingIPs[ip],
			})
		}
		selfNode := *data.Self
		selfNode.Online = true
		addNode(selfNode)
		for _, p := range data.Peer {
			addNode(p)
		}
		sort.SliceStable(peers, func(i, j int) bool {
			if peers[i].OS == "linux" && peers[j].OS != "linux" {
				return true
			}
			if peers[j].OS == "linux" && peers[i].OS != "linux" {
				return false
			}
			return peers[i].Online && !peers[j].Online
		})
		return c.Name, peers
	}
	return "none", []TailscalePeer{}
}

type TestConnResult struct {
	OK       bool   `json:"ok"`
	Hostname string `json:"hostname,omitempty"`
	OS       string `json:"os,omitempty"`
	Error    string `json:"error,omitempty"`
}

func testServerConnection(srv ServerConfig) TestConnResult {
	res, err := execScript(srv, `echo "HOST=$(hostname)"; grep PRETTY_NAME /etc/os-release 2>/dev/null || uname -s`, ExecOpts{
		Timeout: 10 * time.Second,
	})
	if err != nil {
		return TestConnResult{OK: false, Error: err.Error()}
	}
	if res.Code != 0 {
		msg := strings.TrimSpace(res.Stderr)
		if msg == "" {
			msg = fmt.Sprintf("SSH exited with code %d", res.Code)
		}
		return TestConnResult{OK: false, Error: msg}
	}
	lines := strings.Split(strings.TrimSpace(res.Stdout), "\n")
	host := ""
	osLine := ""
	for _, l := range lines {
		if strings.HasPrefix(l, "HOST=") {
			host = strings.TrimPrefix(l, "HOST=")
		} else if strings.HasPrefix(l, "PRETTY_NAME=") {
			osLine = strings.Trim(strings.TrimPrefix(l, "PRETTY_NAME="), `"`)
		}
	}
	if osLine == "" && len(lines) > 1 {
		osLine = lines[1]
	}
	return TestConnResult{OK: true, Hostname: host, OS: osLine}
}
