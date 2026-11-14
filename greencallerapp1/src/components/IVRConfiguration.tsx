import React, { useEffect, useState, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import { Plus, Trash2, Volume2, Loader2, Square, ChevronRight, Phone, Building2, User } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface Department {
  id: string;
  name: string;
}

interface UserProfile {
  id: string;
  full_name: string;
  email: string;
}

interface MenuOption {
  id?: string;
  digit: string;
  label: string;
  department_id: string;
  user_id?: string;
  route_type: 'department' | 'user';
}

interface IVRConfig {
  id?: string;
  company_name: string;
  phone_number_id: string | null;
  greeting_message: string;
  voice: string;
}

interface SavedIVRConfig {
  id: string;
  company_name: string;
  phone_number_id: string | null;
  greeting_message: string;
  voice: string;
  phone_number?: string;
  menu_options: {
    id: string;
    digit: string;
    label: string;
    department_id: string;
    user_id?: string;
    department_name?: string;
    user_name?: string;
  }[];
}

const VOICE_OPTIONS = [
  { value: 'Polly.Amy-Neural', label: 'Amy (British, Neural) - Warm & Professional' },
  { value: 'Polly.Emma-Neural', label: 'Emma (British, Neural) - Friendly & Clear' },
  { value: 'Polly.Brian-Neural', label: 'Brian (British, Neural) - Authoritative' },
  { value: 'Polly.Arthur-Neural', label: 'Arthur (British, Neural) - Distinguished' },
  { value: 'Polly.Joanna-Neural', label: 'Joanna (US, Neural) - Professional' },
  { value: 'Polly.Matthew-Neural', label: 'Matthew (US, Neural) - Confident' },
  { value: 'Polly.Amy', label: 'Amy (British, Standard)' },
  { value: 'Polly.Emma', label: 'Emma (British, Standard)' },
];

export const IVRConfiguration = () => {
  const { toast } = useToast();
  const [companies, setCompanies] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState('');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [phoneNumbers, setPhoneNumbers] = useState<any[]>([]);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [savedConfigs, setSavedConfigs] = useState<SavedIVRConfig[]>([]);
  const [selectedConfig, setSelectedConfig] = useState<SavedIVRConfig | null>(null);
  const [detailsModalOpen, setDetailsModalOpen] = useState(false);
  const [config, setConfig] = useState<IVRConfig>({
    company_name: '',
    phone_number_id: null,
    greeting_message: 'Thank you for calling. Please select from the following options.',
    voice: 'Polly.Amy-Neural',
  });
  const [menuOptions, setMenuOptions] = useState<MenuOption[]>([]);

  useEffect(() => {
    fetchCompanies();
    fetchPhoneNumbers();
    fetchAllIVRConfigs();
  }, []);

  useEffect(() => {
    if (selectedCompany) {
      fetchDepartments(selectedCompany);
      fetchUsers(selectedCompany);
      fetchIVRConfig(selectedCompany);
    }
  }, [selectedCompany]);

  const fetchCompanies = async () => {
    const token = localStorage.getItem("admin_session_token");

    // Fetch companies from profiles
    const { data: profileData } = await supabase
      .from('profiles')
      .select('company_name')
      .not('company_name', 'is', null);

    // Also fetch companies from departments using admin function
    let deptCompanies: string[] = [];
    if (token) {
      try {
        const { data, error } = await supabase.functions.invoke("admin-department", {
          body: { action: "list" },
          headers: { "x-admin-token": token },
        });
        if (!error && data?.success) {
          deptCompanies = (data.departments || [])
            .map((d: any) => d.company_name)
            .filter(Boolean);
        }
      } catch (err) {
        console.error('Error fetching department companies:', err);
      }
    }

    const profileCompanies = profileData?.map(p => p.company_name).filter(Boolean) || [];

    // Merge and deduplicate
    const uniqueCompanies = [...new Set([...profileCompanies, ...deptCompanies])] as string[];
    setCompanies(uniqueCompanies.sort());
  };

  const fetchPhoneNumbers = async () => {
    const { data } = await supabase
      .from('phone_numbers')
      .select('*')
      .order('phone_number');
    
    if (data) {
      setPhoneNumbers(data);
    }
  };

  const fetchAllIVRConfigs = async () => {
    const token = localStorage.getItem("admin_session_token");
    if (!token) {
      console.error("Admin session not found");
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke("admin-ivr", {
        body: { action: "list" },
        headers: { "x-admin-token": token },
      });

      if (error || !data?.success) {
        console.error("Error fetching IVR configs:", error || data?.error);
        return;
      }

      const ivrConfigs = data.configs || [];

      // Fetch phone numbers and departments for enrichment
      const { data: phones } = await supabase.from('phone_numbers').select('id, phone_number');

      // Use admin function for departments
      const { data: deptData } = await supabase.functions.invoke("admin-department", {
        body: { action: "list" },
        headers: { "x-admin-token": token },
      });
      const depts = deptData?.departments || [];

      // Fetch user profiles for enrichment
      const { data: profilesData } = await supabase.from('profiles').select('id, full_name, email');

      const phoneMap = new Map(phones?.map(p => [p.id, p.phone_number]) || []);
      const deptMap = new Map(depts.map((d: any) => [d.id, d.name]));
      const userMap = new Map(profilesData?.map(u => [u.id, u.full_name || u.email || 'Unknown']) || []);

      const enrichedConfigs: SavedIVRConfig[] = ivrConfigs.map((cfg: any) => ({
        id: cfg.id,
        company_name: cfg.company_name,
        phone_number_id: cfg.phone_number_id,
        greeting_message: cfg.greeting_message,
        voice: cfg.voice,
        phone_number: cfg.phone_number_id ? phoneMap.get(cfg.phone_number_id) : undefined,
        menu_options: (cfg.ivr_menu_options || []).map((opt: any) => ({
          ...opt,
          department_name: deptMap.get(opt.department_id),
          user_name: opt.user_id ? userMap.get(opt.user_id) : undefined,
        })),
      }));

      setSavedConfigs(enrichedConfigs);
    } catch (err) {
      console.error("Error fetching IVR configs:", err);
    }
  };

  const handleDeleteIVRConfig = async (configId: string, companyName: string) => {
    if (!confirm(`Are you sure you want to delete the IVR configuration for "${companyName}"?`)) return;

    const token = localStorage.getItem("admin_session_token");
    if (!token) {
      toast({ title: "Error", description: "Admin session not found", variant: "destructive" });
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke("admin-ivr", {
        body: { action: "delete", configId },
        headers: { "x-admin-token": token },
      });

      if (error || !data?.success) {
        throw new Error(data?.error || error?.message || "Failed to delete IVR config");
      }

      toast({ title: "Success", description: `IVR configuration for "${companyName}" deleted` });
      fetchAllIVRConfigs();
    } catch (err: any) {
      toast({ title: "Error", description: err?.message || "Failed to delete", variant: "destructive" });
    }
  };

  const fetchDepartments = async (companyName: string) => {
    // Clear existing departments first to avoid showing wrong company's departments
    setDepartments([]);

    const token = localStorage.getItem("admin_session_token");
    if (!token) {
      console.error("Admin session not found");
      return;
    }

    try {
      // Use admin edge function to bypass RLS
      const { data, error } = await supabase.functions.invoke("admin-department", {
        body: { action: "list" },
        headers: { "x-admin-token": token },
      });

      if (error || !data?.success) {
        console.error('Error fetching departments:', error || data?.error);
        return;
      }

      // Filter departments by company name
      const companyDepts = (data.departments || [])
        .filter((d: any) => d.company_name === companyName)
        .map((d: any) => ({ id: d.id, name: d.name }));

      setDepartments(companyDepts);
    } catch (err) {
      console.error('Error fetching departments:', err);
    }
  };

  const fetchUsers = async (companyName: string) => {
    setUsers([]);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .eq('company_name', companyName)
        .order('full_name');

      if (!error && data) {
        setUsers(data.map(u => ({ id: u.id, full_name: u.full_name || u.email || 'Unknown', email: u.email || '' })));
      }
    } catch (err) {
      console.error('Error fetching users:', err);
    }
  };

  const fetchIVRConfig = async (companyName: string) => {
    const token = localStorage.getItem("admin_session_token");
    if (!token) {
      console.error("Admin session not found");
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke("admin-ivr", {
        body: { action: "get", companyName },
        headers: { "x-admin-token": token },
      });

      if (error) {
        console.error("Error fetching IVR config:", error);
        return;
      }

      const ivrData = data?.config;

      if (ivrData) {
        setConfig({
          id: ivrData.id,
          company_name: ivrData.company_name,
          phone_number_id: ivrData.phone_number_id,
          greeting_message: ivrData.greeting_message,
          voice: ivrData.voice || 'Polly.Amy-Neural',
        });
        setMenuOptions((ivrData.ivr_menu_options || []).map((opt: any) => ({
          ...opt,
          route_type: opt.user_id ? 'user' : 'department',
        })));
      } else {
        setConfig({
          company_name: companyName,
          phone_number_id: null,
          greeting_message: 'Thank you for calling. Please select from the following options.',
          voice: 'Polly.Amy-Neural',
        });
        setMenuOptions([]);
      }
    } catch (err) {
      console.error("Error fetching IVR config:", err);
    }
  };

  const addMenuOption = () => {
    const usedDigits = new Set(menuOptions.map(opt => opt.digit));
    const allDigits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
    const nextDigit = allDigits.find(d => !usedDigits.has(d)) || '1';
    setMenuOptions([...menuOptions, { digit: nextDigit, label: '', department_id: '', user_id: '', route_type: 'department' }]);
  };

  const updateMenuOption = (index: number, field: keyof MenuOption, value: string) => {
    const updated = [...menuOptions];
    updated[index] = { ...updated[index], [field]: value };
    setMenuOptions(updated);
  };

  const removeMenuOption = (index: number) => {
    setMenuOptions(menuOptions.filter((_, i) => i !== index));
  };

  const previewVoice = async (voiceValue: string) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    if (playingVoice === voiceValue) {
      setPlayingVoice(null);
      return;
    }

    setIsPreviewLoading(true);
    setPlayingVoice(voiceValue);

    try {
      const { data, error } = await supabase.functions.invoke('preview-voice', {
        body: { 
          voice: voiceValue,
          text: "Hello, thank you for calling. How may I assist you today?"
        }
      });

      if (error) throw error;

      const audio = new Audio(`data:audio/mp3;base64,${data.audioContent}`);
      audioRef.current = audio;
      
      audio.onended = () => {
        setPlayingVoice(null);
        audioRef.current = null;
      };

      audio.onerror = () => {
        toast({
          title: 'Error',
          description: 'Failed to play audio preview',
          variant: 'destructive',
        });
        setPlayingVoice(null);
      };

      await audio.play();
    } catch (error) {
      console.error('Error previewing voice:', error);
      toast({
        title: 'Error',
        description: 'Failed to generate voice preview',
        variant: 'destructive',
      });
      setPlayingVoice(null);
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const stopPreview = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setPlayingVoice(null);
  };

  const saveConfiguration = async () => {
    if (!selectedCompany) {
      toast({
        title: 'Error',
        description: 'Please select a company',
        variant: 'destructive',
      });
      return;
    }

    if (menuOptions.some(opt => !opt.label || (opt.route_type === 'department' && !opt.department_id) || (opt.route_type === 'user' && !opt.user_id))) {
      toast({
        title: 'Error',
        description: 'Please fill in all menu options (label and target)',
        variant: 'destructive',
      });
      return;
    }

    const digits = menuOptions.map(opt => opt.digit);
    const duplicateDigits = digits.filter((d, i) => digits.indexOf(d) !== i);
    if (duplicateDigits.length > 0) {
      toast({
        title: 'Error',
        description: `Duplicate digit(s): ${[...new Set(duplicateDigits)].join(', ')}. Each menu option must use a unique digit.`,
        variant: 'destructive',
      });
      return;
    }

    const token = localStorage.getItem("admin_session_token");
    if (!token) {
      toast({
        title: 'Error',
        description: 'Admin session not found',
        variant: 'destructive',
      });
      return;
    }

    try {
      const { data, error } = await supabase.functions.invoke("admin-ivr", {
        body: {
          action: "save",
          companyName: selectedCompany,
          phoneNumberId: config.phone_number_id,
          greetingMessage: config.greeting_message,
          voice: config.voice,
          menuOptions: menuOptions.map(opt => ({
            digit: opt.digit,
            label: opt.label,
            department_id: opt.route_type === 'department' ? opt.department_id : null,
            user_id: opt.route_type === 'user' ? opt.user_id : null,
          })),
        },
        headers: { "x-admin-token": token },
      });

      if (error || !data?.success) {
        const edgeFnError = error?.context?.error || error?.context?.message;
        throw new Error(edgeFnError || data?.error || error?.message || "Failed to save IVR configuration");
      }

      toast({
        title: 'Success',
        description: 'IVR configuration saved successfully',
      });

      fetchIVRConfig(selectedCompany);
      fetchAllIVRConfigs();
    } catch (error: any) {
      console.error('Error saving IVR config:', error);
      toast({
        title: 'Error',
        description: error?.message || 'Failed to save IVR configuration',
        variant: 'destructive',
      });
    }
  };

  const openConfigDetails = (cfg: SavedIVRConfig) => {
    setSelectedConfig(cfg);
    setDetailsModalOpen(true);
  };

  const getVoiceLabel = (voiceValue: string) => {
    return VOICE_OPTIONS.find(v => v.value === voiceValue)?.label || voiceValue;
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>IVR Configuration</CardTitle>
          <CardDescription>Configure phone menu for company departments</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Saved IVR Configurations List */}
          {savedConfigs.length > 0 && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">Saved Configurations</Label>
              <div className="space-y-2">
                {savedConfigs.map((cfg) => (
                  <div
                    key={cfg.id}
                    className="w-full flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
                  >
                    <button
                      onClick={() => openConfigDetails(cfg)}
                      className="flex items-center gap-3 flex-1 text-left"
                    >
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                        <Building2 className="w-5 h-5 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium">{cfg.company_name}</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          {cfg.phone_number && (
                            <span className="flex items-center gap-1">
                              <Phone className="w-3 h-3" />
                              {cfg.phone_number}
                            </span>
                          )}
                          <Badge variant="secondary" className="text-[10px]">
                            {cfg.menu_options.length} options
                          </Badge>
                        </div>
                      </div>
                    </button>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteIVRConfig(cfg.id, cfg.company_name);
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                      <ChevronRight className="w-5 h-5 text-muted-foreground" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="border-t pt-6">
            <Label className="text-sm font-medium mb-4 block">
              {savedConfigs.length > 0 ? 'Create or Edit Configuration' : 'Create New Configuration'}
            </Label>
            
            <div className="space-y-2">
              <Label>Company</Label>
              <Select value={selectedCompany} onValueChange={setSelectedCompany}>
                <SelectTrigger>
                  <SelectValue placeholder="Select company" />
                </SelectTrigger>
                <SelectContent>
                  {companies.map(company => (
                    <SelectItem key={company} value={company}>{company}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {selectedCompany && (
            <>
              <div className="space-y-2">
                <Label>Assigned Phone Number</Label>
                <Select 
                  value={config.phone_number_id || ''} 
                  onValueChange={(value) => setConfig({ ...config, phone_number_id: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select phone number" />
                  </SelectTrigger>
                  <SelectContent>
                    {phoneNumbers.map(phone => (
                      <SelectItem key={phone.id} value={phone.id}>
                        {phone.phone_number}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-3">
                <Label>IVR Voice</Label>
                <div className="flex gap-2">
                  <Select 
                    value={config.voice} 
                    onValueChange={(value) => setConfig({ ...config, voice: value })}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder="Select voice" />
                    </SelectTrigger>
                    <SelectContent>
                      {VOICE_OPTIONS.map(voice => (
                        <SelectItem key={voice.value} value={voice.value}>
                          {voice.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => playingVoice ? stopPreview() : previewVoice(config.voice)}
                    disabled={isPreviewLoading}
                    title={playingVoice ? "Stop preview" : "Preview voice"}
                  >
                    {isPreviewLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : playingVoice === config.voice ? (
                      <Square className="h-4 w-4" />
                    ) : (
                      <Volume2 className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Neural voices sound more natural and human-like. Click the speaker icon to preview.</p>
              </div>

              <div className="space-y-2">
                <Label>Greeting Message</Label>
                <Textarea
                  value={config.greeting_message}
                  onChange={(e) => setConfig({ ...config, greeting_message: e.target.value })}
                  rows={3}
                />
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label>Menu Options</Label>
                  <Button onClick={addMenuOption} size="sm" variant="outline">
                    <Plus className="h-4 w-4 mr-1" />
                    Add Option
                  </Button>
                </div>

                {menuOptions.map((option, index) => (
                  <div key={index} className="flex gap-2 items-end flex-wrap">
                    <div className="w-20">
                      <Label>Digit</Label>
                      <Select
                        value={option.digit}
                        onValueChange={(value) => updateMenuOption(index, 'digit', value)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map(digit => (
                            <SelectItem key={digit} value={digit}>{digit}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex-1 min-w-[120px]">
                      <Label>Label</Label>
                      <Input
                        value={option.label}
                        onChange={(e) => updateMenuOption(index, 'label', e.target.value)}
                        placeholder="e.g., Sales"
                      />
                    </div>
                    <div className="w-[130px]">
                      <Label>Route To</Label>
                      <Select
                        value={option.route_type || 'department'}
                        onValueChange={(value) => {
                          const updated = [...menuOptions];
                          updated[index] = { ...updated[index], route_type: value as 'department' | 'user', department_id: '', user_id: '' };
                          setMenuOptions(updated);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="department">Department</SelectItem>
                          <SelectItem value="user">User</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex-1 min-w-[150px]">
                      <Label>{option.route_type === 'user' ? 'User' : 'Department'}</Label>
                      {option.route_type === 'user' ? (
                        <Select
                          value={option.user_id || ''}
                          onValueChange={(value) => updateMenuOption(index, 'user_id' as keyof MenuOption, value)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select user" />
                          </SelectTrigger>
                          <SelectContent>
                            {users.map(user => (
                              <SelectItem key={user.id} value={user.id}>
                                {user.full_name} ({user.email})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Select
                          value={option.department_id}
                          onValueChange={(value) => updateMenuOption(index, 'department_id', value)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select department" />
                          </SelectTrigger>
                          <SelectContent>
                            {departments.map(dept => (
                              <SelectItem key={dept.id} value={dept.id}>{dept.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                    <Button
                      onClick={() => removeMenuOption(index)}
                      size="icon"
                      variant="ghost"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>

              <Button onClick={saveConfiguration} className="w-full">
                Save Configuration
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* IVR Config Details Modal */}
      <Dialog open={detailsModalOpen} onOpenChange={setDetailsModalOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="w-5 h-5" />
              {selectedConfig?.company_name}
            </DialogTitle>
            <DialogDescription>IVR Configuration Details</DialogDescription>
          </DialogHeader>
          
          {selectedConfig && (
            <div className="space-y-4">
              {/* Phone Number */}
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                <Phone className="w-4 h-4 text-muted-foreground" />
                <div>
                  <p className="text-xs text-muted-foreground">Assigned Number</p>
                  <p className="font-medium">{selectedConfig.phone_number || 'Not assigned'}</p>
                </div>
              </div>

              {/* Voice */}
              <div className="p-3 rounded-lg bg-muted/50">
                <p className="text-xs text-muted-foreground mb-1">IVR Voice</p>
                <p className="font-medium text-sm">{getVoiceLabel(selectedConfig.voice)}</p>
              </div>

              {/* Greeting Message */}
              <div className="p-3 rounded-lg bg-muted/50">
                <p className="text-xs text-muted-foreground mb-1">Greeting Message</p>
                <p className="text-sm">{selectedConfig.greeting_message}</p>
              </div>

              {/* Menu Options */}
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground font-medium">Menu Options</p>
                {selectedConfig.menu_options.length > 0 ? (
                  <div className="space-y-2">
                    {selectedConfig.menu_options
                      .sort((a, b) => a.digit.localeCompare(b.digit))
                      .map((opt) => (
                        <div
                          key={opt.id}
                          className="flex items-center gap-3 p-3 rounded-lg border bg-card"
                        >
                          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm">
                            {opt.digit}
                          </div>
                          <div className="flex-1">
                            <p className="font-medium text-sm">{opt.label}</p>
                            <p className="text-xs text-muted-foreground">
                              → {opt.user_id
                                ? <span className="inline-flex items-center gap-1"><User className="w-3 h-3" />{opt.user_name || 'Unknown User'}</span>
                                : <span className="inline-flex items-center gap-1"><Building2 className="w-3 h-3" />{opt.department_name || 'Unknown Department'}</span>
                              }
                            </p>
                          </div>
                        </div>
                      ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No menu options configured</p>
                )}
              </div>

              {/* Edit Button */}
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  setSelectedCompany(selectedConfig.company_name);
                  setDetailsModalOpen(false);
                }}
              >
                Edit Configuration
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};