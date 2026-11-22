package main

type JumpHostConfig struct {
	Host     string `json:"host"`
	Port     int    `json:"port,omitempty"`
	Username string `json:"username"`
}

type QuickLink struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	URL          string `json:"url"`
	Category     string `json:"category"`
	Port         int    `json:"port,omitempty"`
	Description  string `json:"description,omitempty"`
	AutoDetected bool   `json:"autoDetected,omitempty"`
}

type TrafficPlan struct {
	BandwidthMbps    int     `json:"bandwidthMbps,omitempty"`
	MonthlyQuotaGB   float64 `json:"monthlyQuotaGb,omitempty"`
	BillingMode      string  `json:"billingMode,omitempty"` // "both" | "tx" | "rx" | "max"
	ResetDay         int     `json:"resetDay,omitempty"`    // 1-28, default 1
	BaselineGB       float64 `json:"baselineGb,omitempty"`
	BaselineCycleKey string  `json:"baselineCycleKey,omitempty"` // "YYYY-MM-DD" of cycleStart
}

type ServerConfig struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Role        string          `json:"role"`
	Notes       string          `json:"notes"`
	Tags        []string        `json:"tags"`
	Region      string          `json:"region,omitempty"`
	Mode        string          `json:"mode"` // "local" | "ssh"
	Host        string          `json:"host"`
	Port        int             `json:"port"`
	Username    string          `json:"username"`
	UseSudo     bool            `json:"useSudo"`
	PublicIP    string          `json:"publicIp,omitempty"`
	TailscaleIP string          `json:"tailscaleIp,omitempty"`
	JumpHost    *JumpHostConfig `json:"jumpHost,omitempty"`
	QuickLinks  []QuickLink     `json:"quickLinks"`
	TrafficPlan *TrafficPlan    `json:"trafficPlan,omitempty"`
	CreatedAt   string          `json:"createdAt"`
}

type ProcessMetric struct {
	PID     int     `json:"pid"`
	User    string  `json:"user"`
	CPU     float64 `json:"cpu"`
	Mem     float64 `json:"mem"`
	RssKB   int     `json:"rssKb"`
	Command string  `json:"command"`
}

type LiveMetrics struct {
	Timestamp          int64           `json:"timestamp"`
	CPUPercent         float64         `json:"cpuPercent"`
	CPUCores           int             `json:"cpuCores"`
	LoadAvg            [3]float64      `json:"loadAvg"`
	MemTotalBytes      int64           `json:"memTotalBytes"`
	MemUsedBytes       int64           `json:"memUsedBytes"`
	MemAvailableBytes  int64           `json:"memAvailableBytes"`
	MemPercent         float64         `json:"memPercent"`
	SwapTotalBytes     int64           `json:"swapTotalBytes"`
	SwapUsedBytes      int64           `json:"swapUsedBytes"`
	DiskRootTotalBytes int64           `json:"diskRootTotalBytes"`
	DiskRootUsedBytes  int64           `json:"diskRootUsedBytes"`
	DiskRootPercent    float64         `json:"diskRootPercent"`
	NetRxBps           float64         `json:"netRxBps"`
	NetTxBps           float64         `json:"netTxBps"`
	NetTotalRxBytes    int64           `json:"netTotalRxBytes"`
	NetTotalTxBytes    int64           `json:"netTotalTxBytes"`
	NetInterface       string          `json:"netInterface"`
	UptimeSeconds      int64           `json:"uptimeSeconds"`
	TopProcesses       []ProcessMetric `json:"topProcesses"`
}

type DiskMount struct {
	Device     string  `json:"device"`
	Mount      string  `json:"mount"`
	FsType     string  `json:"fsType"`
	TotalBytes int64   `json:"totalBytes"`
	UsedBytes  int64   `json:"usedBytes"`
	AvailBytes int64   `json:"availBytes"`
	UsePercent float64 `json:"usePercent"`
}

type NetInterface struct {
	Name    string   `json:"name"`
	IPv4    []string `json:"ipv4"`
	IPv6    []string `json:"ipv6"`
	RxBytes int64    `json:"rxBytes"`
	TxBytes int64    `json:"txBytes"`
	State   string   `json:"state"`
}

type DockerPort struct {
	HostIP        string `json:"hostIp"`
	HostPort      int    `json:"hostPort"`
	ContainerPort int    `json:"containerPort"`
	Proto         string `json:"proto"`
	IsPublic      bool   `json:"isPublic"`
	QuickURL      string `json:"quickUrl,omitempty"`
}

type DockerContainer struct {
	ID             string       `json:"id"`
	Name           string       `json:"name"`
	Image          string       `json:"image"`
	State          string       `json:"state"`
	Status         string       `json:"status"`
	Health         string       `json:"health,omitempty"`
	ComposeProject string       `json:"composeProject,omitempty"`
	ComposeDir     string       `json:"composeDir,omitempty"`
	Ports          []DockerPort `json:"ports"`
	CPUPercent     *float64     `json:"cpuPercent,omitempty"`
	MemUsage       string       `json:"memUsage,omitempty"`
	MemPercent     *float64     `json:"memPercent,omitempty"`
	NetIO          string       `json:"netIO,omitempty"`
	CreatedAt      string       `json:"createdAt,omitempty"`
}

type SystemdService struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	ActiveState string `json:"activeState"`
	SubState    string `json:"subState"`
	Memory      string `json:"memory,omitempty"`
	PartOf      string `json:"partOf,omitempty"`
	WorkingDir  string `json:"workingDir,omitempty"`
}

type ListeningPort struct {
	Proto           string `json:"proto"`
	Address         string `json:"address"`
	Port            int    `json:"port"`
	Scope           string `json:"scope"`
	Process         string `json:"process"`
	PID             *int   `json:"pid"`
	DockerContainer string `json:"dockerContainer,omitempty"`
}

type UfwRule struct {
	Num     int    `json:"num"`
	To      string `json:"to"`
	Action  string `json:"action"`
	From    string `json:"from"`
	Comment string `json:"comment,omitempty"`
	IPv6    bool   `json:"ipv6"`
}

type NftRule struct {
	Table   string `json:"table"`
	Chain   string `json:"chain"`
	Handle  int    `json:"handle"`
	Proto   string `json:"proto,omitempty"`
	Ports   string `json:"ports,omitempty"`
	Action  string `json:"action"`
	Comment string `json:"comment,omitempty"`
	Raw     string `json:"raw"`
}

type NftTarget struct {
	Table string `json:"table"`
	Chain string `json:"chain"`
}

type FirewallData struct {
	Engine          string          `json:"engine"`
	Active          bool            `json:"active"`
	DefaultIncoming string          `json:"defaultIncoming"`
	DefaultOutgoing string          `json:"defaultOutgoing"`
	UfwRules        []UfwRule       `json:"ufwRules"`
	NftRules        []NftRule       `json:"nftRules,omitempty"`
	NftTarget       *NftTarget      `json:"nftTarget,omitempty"`
	ListeningPorts  []ListeningPort `json:"listeningPorts"`
	RawIptables     string          `json:"rawIptables"`
}

type ProxyRoute struct {
	Engine      string `json:"engine"`
	Domain      string `json:"domain"`
	URL         string `json:"url"`
	Upstream    string `json:"upstream"`
	TLSDaysLeft *int   `json:"tlsDaysLeft"`
	TLSIssuer   string `json:"tlsIssuer,omitempty"`
	ConfigPath  string `json:"configPath,omitempty"`
}

type DiskTopDir struct {
	Path  string `json:"path"`
	Bytes int64  `json:"bytes"`
}

type DockerDfItem struct {
	Type        string `json:"type"`
	Total       string `json:"total"`
	Active      string `json:"active"`
	Size        string `json:"size"`
	Reclaimable string `json:"reclaimable"`
}

type CrontabItem struct {
	Source   string `json:"source"`
	Schedule string `json:"schedule"`
	Command  string `json:"command"`
}

type TimerItem struct {
	Name      string `json:"name"`
	Next      string `json:"next"`
	Activates string `json:"activates"`
}

type RuntimeItem struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type DiskAuditData struct {
	TopDirs  []DiskTopDir   `json:"topDirs"`
	DockerDf []DockerDfItem `json:"dockerDf"`
	Crontabs []CrontabItem  `json:"crontabs"`
	Timers   []TimerItem    `json:"timers"`
	Runtimes []RuntimeItem  `json:"runtimes"`
}

type MeshLatencyCell struct {
	FromID     string   `json:"fromId"`
	ToID       string   `json:"toId"`
	TargetHost string   `json:"targetHost"`
	LatencyMs  *float64 `json:"latencyMs"`
	Error      string   `json:"error,omitempty"`
}

type AlertThresholds struct {
	DiskPercent    float64 `json:"diskPercent"`
	CPUPercent     float64 `json:"cpuPercent"`
	MemPercent     float64 `json:"memPercent"`
	TrafficPercent float64 `json:"trafficPercent"`
	OfflineAlert   bool    `json:"offlineAlert"`
}

type AlertTelegram struct {
	Enabled  bool   `json:"enabled"`
	BotToken string `json:"botToken"`
	ChatID   string `json:"chatId"`
}

type AlertWebhook struct {
	Enabled bool   `json:"enabled"`
	URL     string `json:"url"`
}

type AlertBark struct {
	Enabled bool   `json:"enabled"`
	URL     string `json:"url"`
}

type AlertConfig struct {
	Enabled         bool            `json:"enabled"`
	CooldownMinutes int             `json:"cooldownMinutes"`
	Thresholds      AlertThresholds `json:"thresholds"`
	Telegram        AlertTelegram   `json:"telegram"`
	Webhook         AlertWebhook    `json:"webhook"`
	Bark            AlertBark       `json:"bark"`
}

type AlertEvent struct {
	ID         string `json:"id"`
	TS         string `json:"ts"`
	ServerID   string `json:"serverId"`
	ServerName string `json:"serverName"`
	Kind       string `json:"kind"`
	Message    string `json:"message"`
	Delivered  bool   `json:"delivered"`
}

type FileEntry struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	IsDir     bool   `json:"isDir"`
	IsSymlink bool   `json:"isSymlink"`
	Size      int64  `json:"size"`
	Mode      string `json:"mode"`
	Owner     string `json:"owner"`
	Group     string `json:"group"`
	Mtime     string `json:"mtime"`
}

type FilePreview struct {
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated"`
	Binary    bool   `json:"binary"`
	Content   string `json:"content"`
}

type SshKeyItem struct {
	Index        int    `json:"index"`
	Type         string `json:"type"`
	Key          string `json:"key"`
	Comment      string `json:"comment"`
	Fingerprint  string `json:"fingerprint"`
	IsManagerKey bool   `json:"isManagerKey"`
	RawLine      string `json:"rawLine"`
}

type SshdConfigInfo struct {
	Port                   string `json:"port"`
	PermitRootLogin        string `json:"permitRootLogin"`
	PasswordAuthentication string `json:"passwordAuthentication"`
	PubkeyAuthentication   string `json:"pubkeyAuthentication"`
}

type SshSecurityInfo struct {
	TargetFile       string         `json:"targetFile"`
	Keys             []SshKeyItem   `json:"keys"`
	SshdConfig       SshdConfigInfo `json:"sshdConfig"`
	RecentLogins     []string       `json:"recentLogins"`
	ManagerPublicKey string         `json:"managerPublicKey"`
}

type NodeQualityUnlock struct {
	Service    string `json:"service"`
	Status     string `json:"status"`
	StatusText string `json:"statusText,omitempty"`
	Region     string `json:"region,omitempty"`
	UnlockType string `json:"unlockType,omitempty"`
	Detail     string `json:"detail,omitempty"`
}

type NodeQualityRoute struct {
	ISP       string   `json:"isp"`
	City      string   `json:"city"`
	Proto     string   `json:"proto,omitempty"`
	LineType  string   `json:"lineType"`
	ASN       string   `json:"asn,omitempty"`
	LatencyMs *float64 `json:"latencyMs,omitempty"`
	Detail    string   `json:"detail,omitempty"`
}

type NodeQualityBackrouteTrace struct {
	City     string   `json:"city"`
	ISP      string   `json:"isp"`
	LineType string   `json:"lineType"`
	GeoPath  string   `json:"geoPath,omitempty"`
	ASNPath  string   `json:"asnPath,omitempty"`
	Hops     []string `json:"hops"`
}

type NodeQualityTransferRow struct {
	City               string `json:"city"`
	DelayMs            string `json:"delayMs,omitempty"`
	SendSpeed          string `json:"sendSpeed,omitempty"`
	SendRetransmits    string `json:"sendRetransmits,omitempty"`
	ReceiveSpeed       string `json:"receiveSpeed,omitempty"`
	ReceiveRetransmits string `json:"receiveRetransmits,omitempty"`
}

type NodeQualityRiskSource struct {
	Name  string `json:"name"`
	Score string `json:"score"`
	Level string `json:"level"`
}

type NodeQualityRiskFactorRow struct {
	Provider string `json:"provider"`
	Country  string `json:"country,omitempty"`
	Proxy    string `json:"proxy,omitempty"`
	Tor      string `json:"tor,omitempty"`
	VPN      string `json:"vpn,omitempty"`
	Server   string `json:"server,omitempty"`
	Abuser   string `json:"abuser,omitempty"`
	Robot    string `json:"robot,omitempty"`
}

type NodeQualityTypeMatrixRow struct {
	Provider string `json:"provider"`
	Usage    string `json:"usage,omitempty"`
	Company  string `json:"company,omitempty"`
}

type NodeQualityDelayRow struct {
	Code string `json:"code,omitempty"`
	City string `json:"city"`
	CT   string `json:"ct,omitempty"`
	CU   string `json:"cu,omitempty"`
	CM   string `json:"cm,omitempty"`
}

type NodeQualityFeatureCheck struct {
	Name      string `json:"name"`
	Supported bool   `json:"supported"`
}

type NodeQualityOversell struct {
	Balloon bool `json:"balloon"`
	KSM     bool `json:"ksm"`
}

type NodeQualityIPSummary struct {
	IPv4              string                     `json:"ipv4,omitempty"`
	IPv6              string                     `json:"ipv6,omitempty"`
	ASN               string                     `json:"asn,omitempty"`
	Org               string                     `json:"org,omitempty"`
	Country           string                     `json:"country,omitempty"`
	Continent         string                     `json:"continent,omitempty"`
	RegisteredCountry string                     `json:"registeredCountry,omitempty"`
	City              string                     `json:"city,omitempty"`
	Timezone          string                     `json:"timezone,omitempty"`
	MapURL            string                     `json:"mapUrl,omitempty"`
	UsageType         string                     `json:"usageType,omitempty"`
	IPType            string                     `json:"ipType,omitempty"`
	IsNative          *bool                      `json:"isNative,omitempty"`
	RiskScore         *int                       `json:"riskScore,omitempty"`
	RiskLevel         string                     `json:"riskLevel"`
	RiskSources       []NodeQualityRiskSource    `json:"riskSources"`
	TypeMatrix        []NodeQualityTypeMatrixRow `json:"typeMatrix,omitempty"`
	RiskFactors       []NodeQualityRiskFactorRow `json:"riskFactors,omitempty"`
	BlacklistHit      *int                       `json:"blacklistHit,omitempty"`
	BlacklistMarked   *int                       `json:"blacklistMarked,omitempty"`
	BlacklistClean    *int                       `json:"blacklistClean,omitempty"`
	BlacklistTotal    *int                       `json:"blacklistTotal,omitempty"`
	MailPort25        string                     `json:"mailPort25,omitempty"`
	MailReachable     []string                   `json:"mailReachable,omitempty"`
	ReportSvgURL      string                     `json:"reportSvgUrl,omitempty"`
}

type NodeQualityHardwareSummary struct {
	OS             string                    `json:"os,omitempty"`
	Arch           string                    `json:"arch,omitempty"`
	Virtualization string                    `json:"virtualization,omitempty"`
	CPUModel       string                    `json:"cpuModel,omitempty"`
	Cores          string                    `json:"cores,omitempty"`
	FreqMhz        string                    `json:"freqMhz,omitempty"`
	Cache          string                    `json:"cache,omitempty"`
	Flags          []string                  `json:"flags,omitempty"`
	FeatureChecks  []NodeQualityFeatureCheck `json:"featureChecks,omitempty"`
	GPU            string                    `json:"gpu,omitempty"`
	Memory         string                    `json:"memory,omitempty"`
	Swap           string                    `json:"swap,omitempty"`
	Oversell       *NodeQualityOversell      `json:"oversell,omitempty"`
	Disk           string                    `json:"disk,omitempty"`
	Motherboard    string                    `json:"motherboard,omitempty"`
	NIC            string                    `json:"nic,omitempty"`
	CPUSingle      string                    `json:"cpuSingle,omitempty"`
	CPUMulti       string                    `json:"cpuMulti,omitempty"`
	MemReadMBps    string                    `json:"memReadMBps,omitempty"`
	MemWriteMBps   string                    `json:"memWriteMBps,omitempty"`
	Fio4kRead      string                    `json:"fio4kRead,omitempty"`
	Fio4kWrite     string                    `json:"fio4kWrite,omitempty"`
	Fio1mRead      string                    `json:"fio1mRead,omitempty"`
	Fio1mWrite     string                    `json:"fio1mWrite,omitempty"`
	DdSpeed        string                    `json:"ddSpeed,omitempty"`
	ReportSvgURL   string                    `json:"reportSvgUrl,omitempty"`
}

type NodeQualityBGP struct {
	ASN            string   `json:"asn,omitempty"`
	Org            string   `json:"org,omitempty"`
	Prefix         *int     `json:"prefix,omitempty"`
	RIR            string   `json:"rir,omitempty"`
	ModDate        string   `json:"modDate,omitempty"`
	Country        string   `json:"country,omitempty"`
	Address        string   `json:"address,omitempty"`
	IPActive       *int     `json:"ipActive,omitempty"`
	IPTotal        *int     `json:"ipTotal,omitempty"`
	IXCount        *int     `json:"ixCount,omitempty"`
	UpstreamsCount *int     `json:"upstreamsCount,omitempty"`
	PeersCount     *int     `json:"peersCount,omitempty"`
	Upstreams      []string `json:"upstreams,omitempty"`
}

type NodeQualityLocalNet struct {
	NAT     string `json:"nat,omitempty"`
	Mapping string `json:"mapping,omitempty"`
	Filter  string `json:"filter,omitempty"`
	TCPCc   string `json:"tcpCc,omitempty"`
	Qdisc   string `json:"qdisc,omitempty"`
	Rmem    string `json:"rmem,omitempty"`
	Wmem    string `json:"wmem,omitempty"`
}

type NodeQualitySpeedtestRow struct {
	Node     string `json:"node"`
	Provider string `json:"provider,omitempty"`
	Download string `json:"download,omitempty"`
	Upload   string `json:"upload,omitempty"`
	Latency  string `json:"latency,omitempty"`
}

type NodeQualityNetworkSummary struct {
	BGP             *NodeQualityBGP             `json:"bgp,omitempty"`
	Local           *NodeQualityLocalNet        `json:"local,omitempty"`
	Delays          []NodeQualityDelayRow       `json:"delays,omitempty"`
	Transfers       []NodeQualityTransferRow    `json:"transfers,omitempty"`
	Routes          []NodeQualityRoute          `json:"routes"`
	BackrouteTraces []NodeQualityBackrouteTrace `json:"backrouteTraces,omitempty"`
	Speedtests      []NodeQualitySpeedtestRow   `json:"speedtests"`
	ReportSvgURL    string                      `json:"reportSvgUrl,omitempty"`
}

type NodeQualitySummary struct {
	IP       NodeQualityIPSummary       `json:"ip"`
	Unlocks  []NodeQualityUnlock        `json:"unlocks"`
	Hardware NodeQualityHardwareSummary `json:"hardware"`
	Network  NodeQualityNetworkSummary  `json:"network"`
}

type NodeQualityRawJSON struct {
	Hardware  any `json:"hardware,omitempty"`
	IP        any `json:"ip,omitempty"`
	Net       any `json:"net,omitempty"`
	Backroute any `json:"backroute,omitempty"`
}

type NodeQualityLogs struct {
	Header    string `json:"header,omitempty"`
	Hardware  string `json:"hardware,omitempty"`
	IP        string `json:"ip,omitempty"`
	Net       string `json:"net,omitempty"`
	Backroute string `json:"backroute,omitempty"`
	Combined  string `json:"combined,omitempty"`
}

type NodeQualityRun struct {
	ID         string              `json:"id"`
	ServerID   string              `json:"serverId"`
	Mode       string              `json:"mode"`
	Status     string              `json:"status"`
	StartedAt  string              `json:"startedAt"`
	FinishedAt string              `json:"finishedAt,omitempty"`
	Phase      string              `json:"phase,omitempty"`
	ReportURL  string              `json:"reportUrl,omitempty"`
	Error      string              `json:"error,omitempty"`
	Summary    NodeQualitySummary  `json:"summary"`
	RawJSON    *NodeQualityRawJSON `json:"rawJson,omitempty"`
	Logs       NodeQualityLogs     `json:"logs"`
}

type NodeQualityRunLight struct {
	ID         string             `json:"id"`
	ServerID   string             `json:"serverId"`
	Mode       string             `json:"mode"`
	Status     string             `json:"status"`
	StartedAt  string             `json:"startedAt"`
	FinishedAt string             `json:"finishedAt,omitempty"`
	Phase      string             `json:"phase,omitempty"`
	ReportURL  string             `json:"reportUrl,omitempty"`
	Error      string             `json:"error,omitempty"`
	Summary    NodeQualitySummary `json:"summary"`
}

type ActiveNQJobInfo struct {
	ID        string   `json:"id"`
	Mode      string   `json:"mode"`
	Phase     string   `json:"phase"`
	StartedAt string   `json:"startedAt"`
	LogLines  []string `json:"logLines,omitempty"`
}

type DockerSummary struct {
	Total     int `json:"total"`
	Running   int `json:"running"`
	Stopped   int `json:"stopped"`
	Unhealthy int `json:"unhealthy"`
}

type FirewallSummary struct {
	Engine              string `json:"engine"`
	Active              bool   `json:"active"`
	PublicPortsCount    int    `json:"publicPortsCount"`
	TailscalePortsCount int    `json:"tailscalePortsCount"`
	LocalPortsCount     int    `json:"localPortsCount"`
}

type ComposeDirInfo struct {
	Project string `json:"project"`
	Dir     string `json:"dir"`
}

type LatestNQSummary struct {
	ID         string             `json:"id"`
	StartedAt  string             `json:"startedAt"`
	FinishedAt string             `json:"finishedAt,omitempty"`
	Mode       string             `json:"mode"`
	Status     string             `json:"status"`
	ReportURL  string             `json:"reportUrl,omitempty"`
	Summary    NodeQualitySummary `json:"summary"`
}

type NetworkHealthBrief struct {
	Mode        string   `json:"mode"`
	Grade       string   `json:"grade"`
	Headline    string   `json:"headline"`
	AvgLossPct  float64  `json:"avgLossPct"`
	MaxLossPct  float64  `json:"maxLossPct"`
	PeakDeltaMs *float64 `json:"peakDeltaMs,omitempty"`
	Samples     int      `json:"samples"`
}

type AutoNQConfig struct {
	Enabled        bool   `json:"enabled"`
	IntervalDays   int    `json:"intervalDays"`
	Mode           string `json:"mode"`
	AlertOnDegrade bool   `json:"alertOnDegrade"`
}

type DailyTrafficPoint struct {
	Day       string  `json:"day"`
	RxBytes   int64   `json:"rxBytes"`
	TxBytes   int64   `json:"txBytes"`
	PeakRxBps float64 `json:"peakRxBps"`
	PeakTxBps float64 `json:"peakTxBps"`
}

type TrafficSummary struct {
	CycleStart     string              `json:"cycleStart"`
	CycleEnd       string              `json:"cycleEnd"`
	DaysElapsed    int                 `json:"daysElapsed"`
	DaysTotal      int                 `json:"daysTotal"`
	DaysRemaining  int                 `json:"daysRemaining"`
	TodayRxBytes   int64               `json:"todayRxBytes"`
	TodayTxBytes   int64               `json:"todayTxBytes"`
	CycleRxBytes   int64               `json:"cycleRxBytes"`
	CycleTxBytes   int64               `json:"cycleTxBytes"`
	BaselineBytes  int64               `json:"baselineBytes"`
	BilledBytes    int64               `json:"billedBytes"`
	QuotaBytes     int64               `json:"quotaBytes"`
	UsedPercent    float64             `json:"usedPercent"`
	ProjectedBytes int64               `json:"projectedBytes"`
	PeakRxBps      float64             `json:"peakRxBps"`
	PeakTxBps      float64             `json:"peakTxBps"`
	BandwidthMbps  int                 `json:"bandwidthMbps"`
	BillingMode    string              `json:"billingMode"`
	ResetDay       int                 `json:"resetDay"`
	DailySeries    []DailyTrafficPoint `json:"dailySeries,omitempty"`
}

type ServerSnapshot struct {
	Server               ServerConfig        `json:"server"`
	Online               bool                `json:"online"`
	Error                string              `json:"error,omitempty"`
	Hostname             string              `json:"hostname,omitempty"`
	OS                   string              `json:"os,omitempty"`
	Kernel               string              `json:"kernel,omitempty"`
	Arch                 string              `json:"arch,omitempty"`
	CPUModel             string              `json:"cpuModel,omitempty"`
	CPUCores             int                 `json:"cpuCores,omitempty"`
	PublicIP             string              `json:"publicIp,omitempty"`
	TailscaleIP          string              `json:"tailscaleIp,omitempty"`
	Metrics              *LiveMetrics        `json:"metrics,omitempty"`
	Disks                []DiskMount         `json:"disks"`
	Interfaces           []NetInterface      `json:"interfaces"`
	DockerAvailable      bool                `json:"dockerAvailable"`
	DockerSummary        DockerSummary       `json:"dockerSummary"`
	ContainersPreview    []DockerContainer   `json:"containersPreview"`
	SystemdHighlights    []SystemdService    `json:"systemdHighlights"`
	FirewallSummary      FirewallSummary     `json:"firewallSummary"`
	PublicPortsPreview   []ListeningPort     `json:"publicPortsPreview"`
	ComposeDirs          []ComposeDirInfo    `json:"composeDirs"`
	DetectedLinks        []QuickLink         `json:"detectedLinks"`
	LatestNodeQuality    *LatestNQSummary    `json:"latestNodeQuality,omitempty"`
	ActiveNodeQualityJob *ActiveNQJobInfo    `json:"activeNodeQualityJob,omitempty"`
	NetworkSummary       *NetworkHealthBrief `json:"networkSummary,omitempty"`
	TrafficSummary       *TrafficSummary     `json:"trafficSummary,omitempty"`
	CollectedAt          string              `json:"collectedAt"`
}

type TailscalePeer struct {
	ID           string `json:"id"`
	HostName     string `json:"hostName"`
	DNSName      string `json:"dnsName"`
	TailscaleIP  string `json:"tailscaleIp"`
	OS           string `json:"os"`
	Online       bool   `json:"online"`
	LastSeen     string `json:"lastSeen,omitempty"`
	AlreadyAdded bool   `json:"alreadyAdded"`
}

type MetricHistoryPoint struct {
	TS          int64   `json:"ts"`
	CPUPercent  float64 `json:"cpuPercent"`
	MemPercent  float64 `json:"memPercent"`
	DiskPercent float64 `json:"diskPercent"`
	Load1       float64 `json:"load1"`
	NetRxBps    int64   `json:"netRxBps"`
	NetTxBps    int64   `json:"netTxBps"`
}

type MetricTraffic struct {
	RxBytes int64 `json:"rxBytes"`
	TxBytes int64 `json:"txBytes"`
}

type MetricHistoryResult struct {
	Range       string               `json:"range"`
	Points      []MetricHistoryPoint `json:"points"`
	Traffic     MetricTraffic        `json:"traffic"`
	SampleCount int                  `json:"sampleCount"`
}
