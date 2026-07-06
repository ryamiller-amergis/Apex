import React, { useState, useMemo, useRef, useEffect } from 'react';
import { azureCostService, AzureSubscription, CostData, DashboardData } from '../services/azureCostService';
import { ApexLoader } from './ApexLoader';
import './CloudCost.css';

interface CloudCostProps {
  project: string;
  areaPath: string;
}

// SessionStorage keys
const STORAGE_KEYS = {
  SUBSCRIPTIONS: 'cloudCost_subscriptions',
  DASHBOARD_DATA: 'cloudCost_dashboardData',
  SELECTED_SUBSCRIPTION: 'cloudCost_selectedSubscription',
  SELECTED_RESOURCE_GROUPS: 'cloudCost_selectedResourceGroups',
  TIME_PERIOD: 'cloudCost_timePeriod',
  CUSTOM_START_DATE: 'cloudCost_customStartDate',
  CUSTOM_END_DATE: 'cloudCost_customEndDate',
  SHOW_DASHBOARD: 'cloudCost_showDashboard',
  COST_DATA: 'cloudCost_costData',
};

// Helper functions for sessionStorage
const saveToStorage = (key: string, value: any) => {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`Failed to save ${key} to sessionStorage:`, error);
  }
};

const loadFromStorage = <T,>(key: string, defaultValue: T): T => {
  try {
    const item = sessionStorage.getItem(key);
    return item ? JSON.parse(item) : defaultValue;
  } catch (error) {
    console.error(`Failed to load ${key} from sessionStorage:`, error);
    return defaultValue;
  }
};

export const CloudCost: React.FC<CloudCostProps> = () => {
  // Initialize state from sessionStorage
  const [subscriptions, setSubscriptions] = useState<AzureSubscription[]>(() => 
    loadFromStorage(STORAGE_KEYS.SUBSCRIPTIONS, [])
  );
  const [selectedSubscription, setSelectedSubscription] = useState<string>(() => 
    loadFromStorage(STORAGE_KEYS.SELECTED_SUBSCRIPTION, '')
  );
  const [selectedResourceGroups, setSelectedResourceGroups] = useState<string[]>(() => 
    loadFromStorage(STORAGE_KEYS.SELECTED_RESOURCE_GROUPS, [])
  );
  const [timePeriod, setTimePeriod] = useState<string>(() => 
    loadFromStorage(STORAGE_KEYS.TIME_PERIOD, '30d')
  );
  const [customStartDate, setCustomStartDate] = useState<string>(() => 
    loadFromStorage(STORAGE_KEYS.CUSTOM_START_DATE, '')
  );
  const [customEndDate, setCustomEndDate] = useState<string>(() => 
    loadFromStorage(STORAGE_KEYS.CUSTOM_END_DATE, '')
  );
  const [isResourceGroupDropdownOpen, setIsResourceGroupDropdownOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(() => {
    // If we have subscriptions in storage, we're not loading
    const cachedSubscriptions = loadFromStorage<AzureSubscription[]>(STORAGE_KEYS.SUBSCRIPTIONS, []);
    return cachedSubscriptions.length === 0;
  });
  const [error, setError] = useState<string | null>(null);
  const [costData, setCostData] = useState<CostData | null>(() => 
    loadFromStorage(STORAGE_KEYS.COST_DATA, null)
  );
  const [isFetchingCostData, setIsFetchingCostData] = useState(false);
  const [openInfoModal, setOpenInfoModal] = useState<string | null>(null);
  const [resourceGroupSearch, setResourceGroupSearch] = useState<string>('');
  const [showDashboard, setShowDashboard] = useState(() => 
    loadFromStorage(STORAGE_KEYS.SHOW_DASHBOARD, true)
  );
  const [dashboardData, setDashboardData] = useState<DashboardData[]>(() => 
    loadFromStorage(STORAGE_KEYS.DASHBOARD_DATA, [])
  );
  const [isLoadingDashboard, setIsLoadingDashboard] = useState(() => {
    // If we have dashboard data in storage, we're not loading
    const cachedDashboard = loadFromStorage<DashboardData[]>(STORAGE_KEYS.DASHBOARD_DATA, []);
    return cachedDashboard.length === 0;
  });
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Save state to sessionStorage when it changes
  useEffect(() => {
    saveToStorage(STORAGE_KEYS.SUBSCRIPTIONS, subscriptions);
  }, [subscriptions]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.DASHBOARD_DATA, dashboardData);
  }, [dashboardData]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.SELECTED_SUBSCRIPTION, selectedSubscription);
  }, [selectedSubscription]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.SELECTED_RESOURCE_GROUPS, selectedResourceGroups);
  }, [selectedResourceGroups]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.TIME_PERIOD, timePeriod);
  }, [timePeriod]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.CUSTOM_START_DATE, customStartDate);
  }, [customStartDate]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.CUSTOM_END_DATE, customEndDate);
  }, [customEndDate]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.SHOW_DASHBOARD, showDashboard);
  }, [showDashboard]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.COST_DATA, costData);
  }, [costData]);

  // Fetch dashboard data on mount
  useEffect(() => {
    // Only fetch if we don't already have dashboard data
    if (dashboardData.length > 0) {
      return;
    }

    const fetchDashboardData = async () => {
      try {
        setIsLoadingDashboard(true);
        setError(null);
        const data = await azureCostService.getDashboardData(5);
        setDashboardData(data);
      } catch (err) {
        console.error('Failed to fetch dashboard data:', err);
        setError(err instanceof Error ? err.message : 'Failed to load dashboard data');
      } finally {
        setIsLoadingDashboard(false);
      }
    };

    fetchDashboardData();
  }, [dashboardData.length]);

  // Fetch subscriptions on mount
  useEffect(() => {
    // Only fetch if we don't already have subscriptions
    if (subscriptions.length > 0) {
      return;
    }

    const fetchSubscriptions = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const data = await azureCostService.getSubscriptionsWithResourceGroups();
        setSubscriptions(data);
        
        // Auto-select first subscription only if none is selected
        if (data.length > 0 && !selectedSubscription) {
          setSelectedSubscription(data[0].subscriptionId);
        }
      } catch (err) {
        console.error('Failed to fetch Azure subscriptions:', err);
        setError(err instanceof Error ? err.message : 'Failed to load Azure subscriptions');
      } finally {
        setIsLoading(false);
      }
    };

    fetchSubscriptions();
  }, [subscriptions.length, selectedSubscription]);

  const currentSubscription = useMemo(() => 
    subscriptions.find(sub => sub.subscriptionId === selectedSubscription),
    [subscriptions, selectedSubscription]
  );

  const availableResourceGroups = currentSubscription?.resourceGroups || [];

  // Filter resource groups based on search and sort alphabetically
  const filteredResourceGroups = useMemo(() => {
    const groups = resourceGroupSearch 
      ? availableResourceGroups.filter(rg => 
          rg.toLowerCase().includes(resourceGroupSearch.toLowerCase())
        )
      : availableResourceGroups;
    
    return groups.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [availableResourceGroups, resourceGroupSearch]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsResourceGroupDropdownOpen(false);
      }
    };

    if (isResourceGroupDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isResourceGroupDropdownOpen]);

  const handleSubscriptionChange = (subscriptionId: string) => {
    setSelectedSubscription(subscriptionId);
    setSelectedResourceGroups([]); // Reset resource groups when subscription changes
    setResourceGroupSearch(''); // Reset search when subscription changes
  };

  const toggleResourceGroup = (rg: string) => {
    setSelectedResourceGroups(prev => 
      prev.includes(rg) 
        ? prev.filter(item => item !== rg)
        : [...prev, rg]
    );
  };

  const selectAllResourceGroups = () => {
    setSelectedResourceGroups(availableResourceGroups);
  };

  const clearAllResourceGroups = () => {
    setSelectedResourceGroups([]);
  };

  // Manual refresh dashboard data
  const refreshDashboardData = async () => {
    try {
      setIsLoadingDashboard(true);
      setError(null);
      const data = await azureCostService.getDashboardData(5);
      setDashboardData(data);
    } catch (err) {
      console.error('Failed to fetch dashboard data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load dashboard data');
    } finally {
      setIsLoadingDashboard(false);
    }
  };

  // Navigate to detailed analysis from dashboard
  const navigateToDetailedAnalysis = async (subscriptionId: string, resourceGroupName: string) => {
    console.log('[Navigate] Navigating to detailed analysis:', { subscriptionId, resourceGroupName });
    console.log('[Navigate] Resource group name length:', resourceGroupName.length);
    console.log('[Navigate] Resource group name charCodes:', Array.from(resourceGroupName).map(c => c.charCodeAt(0)));
    
    // Find the subscription to verify it exists and has the resource group
    const subscription = subscriptions.find(sub => sub.subscriptionId === subscriptionId);
    console.log('[Navigate] Found subscription:', subscription);
    console.log('[Navigate] Available resource groups:', subscription?.resourceGroups);
    
    // Find the exact matching resource group name (case-insensitive match)
    // This handles cases where the dashboard data and subscription data have different casing
    let matchingResourceGroupName = resourceGroupName;
    if (subscription?.resourceGroups) {
      const exactMatch = subscription.resourceGroups.find(rg => rg === resourceGroupName);
      if (exactMatch) {
        matchingResourceGroupName = exactMatch;
        console.log('[Navigate] Found exact match:', matchingResourceGroupName);
      } else {
        // Try case-insensitive match
        const caseInsensitiveMatch = subscription.resourceGroups.find(
          rg => rg.toLowerCase() === resourceGroupName.toLowerCase()
        );
        if (caseInsensitiveMatch) {
          matchingResourceGroupName = caseInsensitiveMatch;
          console.log('[Navigate] Found case-insensitive match:', matchingResourceGroupName, '(original:', resourceGroupName, ')');
        } else {
          console.warn('[Navigate] No matching resource group found in subscription!');
        }
      }
    }
    
    // Set the subscription and resource group
    setSelectedSubscription(subscriptionId);
    setSelectedResourceGroups([matchingResourceGroupName]);
    setResourceGroupSearch(''); // Clear search to ensure selected resource group is visible
    
    console.log('[Navigate] State updated - subscription:', subscriptionId, 'resourceGroups:', [matchingResourceGroupName]);
    
    // Switch to detailed analysis view
    setShowDashboard(false);
    
    // Auto-fetch cost data for this selection
    try {
      setIsFetchingCostData(true);
      const data = await azureCostService.getCostData(
        subscriptionId,
        [matchingResourceGroupName],
        timePeriod,
        customStartDate,
        customEndDate
      );
      setCostData(data);
    } catch (err) {
      console.error('Failed to fetch cost data:', err);
    } finally {
      setIsFetchingCostData(false);
    }
  };

  // Manual fetch cost data triggered by submit button
  const fetchCostData = async () => {
    if (!selectedSubscription || selectedResourceGroups.length === 0) {
      return;
    }

    // Validate custom dates if custom period is selected
    if (timePeriod === 'custom' && (!customStartDate || !customEndDate)) {
      alert('Please select both start and end dates for custom range');
      return;
    }

    try {
      setIsFetchingCostData(true);
      console.log('Fetching cost data for:', {
        subscription: selectedSubscription,
        resourceGroups: selectedResourceGroups,
        timePeriod,
        customStartDate,
        customEndDate
      });
      const data = await azureCostService.getCostData(
        selectedSubscription,
        selectedResourceGroups,
        timePeriod,
        customStartDate,
        customEndDate
      );
      console.log('Received cost data:', {
        totalCost: data.totalCost,
        resourceGroups: data.costByResourceGroup,
        detailsCount: data.costDetails.length,
        uniqueRGs: [...new Set(data.costDetails.map(d => d.resourceGroup))],
        costByDay: data.costByDay,
        sampleDates: data.costByDay.slice(0, 3).map(d => ({ date: d.date, type: typeof d.date })),
        allServices: [...new Set(data.costDetails.map(d => d.service))],
        appInsightsResources: data.costDetails.filter(d => 
          d.service.toLowerCase().includes('insight') || 
          d.service.toLowerCase().includes('application')
        )
      });
      setCostData(data);
    } catch (err) {
      console.error('Failed to fetch cost data:', err);
      // Don't set error state, just log it
    } finally {
      setIsFetchingCostData(false);
    }
  };

  const formatCurrency = (amount: number): string => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  };

  const formatPercentChange = (change: number): string => {
    const sign = change >= 0 ? '+' : '';
    return `${sign}${change.toFixed(1)}%`;
  };

  const renderTrend = (trend: number, className?: string) => {
    if (Math.abs(trend) <= 2) {
      return <span className={`trend-stable ${className || ''}`}>—</span>;
    }
    const isUp = trend > 0;
    return (
      <span className={`${isUp ? 'trend-up' : 'trend-down'} ${className || ''}`}>
        {isUp ? '↗' : '↘'} {formatPercentChange(trend)}
      </span>
    );
  };

  // Aggregate cost data based on time period for better visualization
  const aggregateCostData = (costByDay: Array<{ date: string; cost: number }>, period: string) => {
    if (!costByDay || costByDay.length === 0) return [];
    
    // For 7 days, show all days
    if (period === '7d') {
      return costByDay;
    }
    
    // For 30 days, group by week (show ~4-5 data points)
    if (period === '30d') {
      const grouped: Array<{ date: string; cost: number }> = [];
      for (let i = 0; i < costByDay.length; i += 7) {
        const weekData = costByDay.slice(i, i + 7);
        const totalCost = weekData.reduce((sum, day) => sum + day.cost, 0);
        grouped.push({
          date: weekData[0].date, // Use first day of week
          cost: totalCost
        });
      }
      return grouped;
    }
    
    // For 90 days, group by 2 weeks (show ~6-7 data points)
    if (period === '90d') {
      const grouped: Array<{ date: string; cost: number }> = [];
      for (let i = 0; i < costByDay.length; i += 14) {
        const periodData = costByDay.slice(i, i + 14);
        const totalCost = periodData.reduce((sum, day) => sum + day.cost, 0);
        grouped.push({
          date: periodData[0].date,
          cost: totalCost
        });
      }
      return grouped;
    }
    
    return costByDay;
  };

  const getInfoContent = (section: string) => {
    const content: { [key: string]: { title: string; description: string; keyPoints: string[]; insight: string } } = {
      'total-spend': {
        title: 'Total Spend',
        description: 'Sum of all Azure costs across selected resource groups',
        keyPoints: [
          'Includes all services, resources, and usage charges',
          'Covers the entire selected time period',
          'Percentage shows trend: first half vs second half'
        ],
        insight: 'Use this to track overall cloud spending and identify budget alignment'
      },
      'daily-average': {
        title: 'Daily Average',
        description: 'Total cost divided by number of days',
        keyPoints: [
          'Normalizes costs across different time ranges',
          'Enables comparison between periods',
          'Useful for forecasting future costs'
        ],
        insight: 'Identify unusual spending days and establish baseline costs'
      },
      'projected-monthly': {
        title: 'Projected Monthly Cost',
        description: 'Estimated monthly spending based on current daily average × 30',
        keyPoints: [
          'Assumes current usage patterns continue',
          'Helps predict upcoming bills',
          'Updates as usage patterns change'
        ],
        insight: 'Note: Actual costs may vary based on usage changes or new resources'
      },
      'cost-trend': {
        title: 'Cost Trend',
        description: 'Visual representation of daily spending patterns',
        keyPoints: [
          'Peak Day: Highest cost in the period',
          'Lowest Day: Minimum cost baseline',
          'Trend Direction: Overall cost trajectory'
        ],
        insight: 'Look for spikes that may indicate misconfigured resources or optimization opportunities'
      },
      'cost-by-rg': {
        title: 'Cost by Resource Group',
        description: 'Total costs grouped by Azure resource groups',
        keyPoints: [
          'Identifies which projects drive costs',
          'Shows team/application spending',
          '$0.00 = No billable usage in period'
        ],
        insight: 'Use this to allocate costs and identify high-spend areas'
      },
      'cost-details': {
        title: 'Cost Details',
        description: 'Granular breakdown by resource group, service, and resource',
        keyPoints: [
          'Daily Cost: Average per day',
          'Total Cost: Sum for entire period',
          'Trend: First half vs second half comparison'
        ],
        insight: 'Drill down to specific resources driving your Azure spending'
      }
    };
    return content[section] || { title: '', description: '', keyPoints: [], insight: '' };
  };

  return (
    <div className="cloud-cost">
      {openInfoModal && (
        <div className="info-modal-overlay" onClick={() => setOpenInfoModal(null)}>
          <div className="info-modal" onClick={(e) => e.stopPropagation()}>
            <div className="info-modal-header">
              <h3>{getInfoContent(openInfoModal).title}</h3>
              <button className="close-button" onClick={() => setOpenInfoModal(null)}>×</button>
            </div>
            <div className="info-modal-content">
              <p className="modal-description">{getInfoContent(openInfoModal).description}</p>
              <div className="modal-section">
                <h4>Key Points</h4>
                <ul className="key-points-list">
                  {getInfoContent(openInfoModal).keyPoints.map((point, index) => (
                    <li key={index}>{point}</li>
                  ))}
                </ul>
              </div>
              <div className="modal-insight">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="insight-icon">
                  <path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm.93-9.412-1 4.705c-.07.34.029.533.304.533.194 0 .487-.07.686-.246l-.088.416c-.287.346-.92.598-1.465.598-.703 0-1.002-.422-.808-1.319l.738-3.468c.064-.293.006-.399-.287-.47l-.451-.081.082-.381 2.29-.287zM8 5.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>
                </svg>
                <span>{getInfoContent(openInfoModal).insight}</span>
              </div>
            </div>
          </div>
        </div>
      )}
      
      <div className="cloud-cost-header">
        <div className="header-title-row">
          <h2>Cloud Cost Analytics</h2>
          <div className="header-actions">
            <div className="view-toggle">
              <button 
                className={`toggle-btn ${showDashboard ? 'active' : ''}`}
                onClick={() => setShowDashboard(true)}
              >
                Dashboard
              </button>
              <button 
                className={`toggle-btn ${!showDashboard ? 'active' : ''}`}
                onClick={() => setShowDashboard(false)}
              >
                Detailed Analysis
              </button>
            </div>
            {showDashboard && (
              <button 
                className="refresh-btn"
                onClick={refreshDashboardData}
                disabled={isLoadingDashboard}
                title="Refresh dashboard data"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={isLoadingDashboard ? 'spinning' : ''}>
                  <path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-11 2h3.932a.25.25 0 0 0 .192-.41L2.692 6.23a.25.25 0 0 0-.384 0L.342 8.59A.25.25 0 0 0 .534 9z"/>
                  <path fillRule="evenodd" d="M8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 1 1-.771-.636A6.002 6.002 0 0 1 13.917 7H12.9A5.002 5.002 0 0 0 8 3zM3.1 9a5.002 5.002 0 0 0 8.757 2.182.5.5 0 1 1 .771.636A6.002 6.002 0 0 1 2.083 9H3.1z"/>
                </svg>
                Refresh
              </button>
            )}
          </div>
        </div>
        {isLoading ? (
          <div className="loading-message"><ApexLoader size={40} /></div>
        ) : error ? (
          <div className="error-message">{error}</div>
        ) : !showDashboard ? (
          <div className="cloud-cost-filters">
            <div className="filter-group">
              <label>Subscription:</label>
              <select 
                className="filter-select"
                value={selectedSubscription}
                onChange={(e) => handleSubscriptionChange(e.target.value)}
                disabled={subscriptions.length === 0}
              >
                {subscriptions.length === 0 ? (
                  <option value="">No subscriptions available</option>
                ) : (
                  <>
                    <option value="">Select a subscription...</option>
                    {subscriptions.map(sub => (
                      <option key={sub.subscriptionId} value={sub.subscriptionId}>
                        {sub.name}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </div>
          
          <div className="filter-group resource-group-filter" ref={dropdownRef}>
            <label>Resource Groups:</label>
            <div className="multi-select-container">
              <button 
                className="multi-select-trigger"
                onClick={() => {
                  const newState = !isResourceGroupDropdownOpen;
                  console.log('[Dropdown] Toggling dropdown to:', newState);
                  if (newState) {
                    console.log('[Dropdown] Current state:', {
                      selectedSubscription,
                      selectedResourceGroups,
                      availableResourceGroups,
                      filteredResourceGroups,
                      resourceGroupSearch
                    });
                  }
                  setIsResourceGroupDropdownOpen(newState);
                }}
                disabled={subscriptions.length === 0 || availableResourceGroups.length === 0}
              >
                <span className="multi-select-value">
                  {selectedResourceGroups.length === 0 
                    ? 'Select resource groups...'
                    : selectedResourceGroups.length === availableResourceGroups.length
                    ? 'All resource groups'
                    : `${selectedResourceGroups.length} selected`
                  }
                </span>
                <span className={`multi-select-arrow ${isResourceGroupDropdownOpen ? 'open' : ''}`}>▼</span>
              </button>
              
              {isResourceGroupDropdownOpen && (
                <div className="multi-select-dropdown">
                  <div className="multi-select-search">
                    <input
                      type="text"
                      placeholder="Search resource groups..."
                      value={resourceGroupSearch}
                      onChange={(e) => setResourceGroupSearch(e.target.value)}
                      className="resource-group-search-input"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                  <div className="multi-select-actions">
                    <button 
                      className="select-action-btn"
                      onClick={selectAllResourceGroups}
                    >
                      Select All
                    </button>
                    <button 
                      className="select-action-btn"
                      onClick={clearAllResourceGroups}
                    >
                      Clear All
                    </button>
                  </div>
                  <div className="multi-select-options">
                    {filteredResourceGroups.length > 0 ? (
                      filteredResourceGroups.map(rg => {
                        const isChecked = selectedResourceGroups.includes(rg);
                        if (isChecked) {
                          console.log('[Checkbox] Resource group IS CHECKED:', rg);
                        }
                        // Log comparison details for debugging
                        selectedResourceGroups.forEach(selectedRg => {
                          if (selectedRg.toLowerCase() === rg.toLowerCase() && selectedRg !== rg) {
                            console.log('[Checkbox] CASE MISMATCH:', {
                              selected: selectedRg,
                              available: rg,
                              match: selectedRg === rg
                            });
                          }
                        });
                        return (
                          <label key={rg} className="multi-select-option">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleResourceGroup(rg)}
                            />
                            <span>{rg}</span>
                          </label>
                        );
                      })
                    ) : (
                      <div className="no-results">No resource groups found</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="filter-group">
            <label>Time Period:</label>
            <select 
              className="filter-select"
              value={timePeriod}
              onChange={(e) => setTimePeriod(e.target.value)}
              disabled={subscriptions.length === 0}
            >
              <option value="7d">Last 7 Days</option>
              <option value="30d">Last 30 Days</option>
              <option value="90d">Last 90 Days</option>
              <option value="custom">Custom Range</option>
            </select>
          </div>

          {timePeriod === 'custom' && (
            <>
              <div className="filter-group">
                <label>Start Date:</label>
                <input
                  type="date"
                  className="filter-select date-input"
                  value={customStartDate}
                  onChange={(e) => setCustomStartDate(e.target.value)}
                  max={customEndDate || new Date().toISOString().split('T')[0]}
                />
              </div>
              <div className="filter-group">
                <label>End Date:</label>
                <input
                  type="date"
                  className="filter-select date-input"
                  value={customEndDate}
                  onChange={(e) => setCustomEndDate(e.target.value)}
                  min={customStartDate}
                  max={new Date().toISOString().split('T')[0]}
                />
              </div>
            </>
          )}

          <div className="filter-group">
            <button 
              className="fetch-cost-btn"
              onClick={fetchCostData}
              disabled={!selectedSubscription || selectedResourceGroups.length === 0 || isFetchingCostData}
            >
              {isFetchingCostData ? 'Loading...' : 'Get Cost Data'}
            </button>
          </div>
        </div>
        ) : null}
      </div>

      <div className="cloud-cost-content">
        {showDashboard ? (
          // Dashboard View
          isLoadingDashboard ? (
            <div className="loading-cost-data">
              <ApexLoader size={56} />
              <p>Loading dashboard data...</p>
            </div>
          ) : dashboardData.length === 0 ? (
            <div className="no-selection-message">
              <p>No cost data available across subscriptions.</p>
            </div>
          ) : (
            <div className="dashboard-view">
              <div className="dashboard-header">
                <h3>Top Resource Groups by Cost (Last 30 Days)</h3>
                <p className="dashboard-subtitle">Quick overview of cost drivers across all subscriptions</p>
              </div>
              
              <div className="dashboard-grid">
                {dashboardData.map((subscription) => (
                  <div key={subscription.subscriptionId} className="dashboard-subscription-card">
                    <div className="subscription-header">
                      <h4>{subscription.subscriptionName}</h4>
                      <span className="subscription-id">{subscription.subscriptionId}</span>
                    </div>
                    
                    {subscription.topResourceGroups.length === 0 ? (
                      <div className="no-costs">
                        <p>No billable resources in this subscription</p>
                      </div>
                    ) : (
                      <div className="resource-group-list">
                        {subscription.topResourceGroups.map((rg, index) => (
                          <div 
                            key={rg.name} 
                            className="rg-item clickable"
                            onClick={() => navigateToDetailedAnalysis(subscription.subscriptionId, rg.name)}
                            title="Click to view detailed analysis"
                          >
                            <div className="rg-rank">{index + 1}</div>
                            <div className="rg-details">
                              <div className="rg-name">{rg.name}</div>
                              <div className="rg-cost-row">
                                <span className="rg-cost">{formatCurrency(rg.cost)}</span>
                                {renderTrend(rg.trend, 'rg-trend')}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              
              <div className="dashboard-footer">
                <p>Click any resource group to view detailed analysis, or use "Detailed Analysis" above to create custom filters</p>
              </div>
            </div>
          )
        ) : (
          // Detailed Analysis View (existing functionality)
          <>
            {!costData && !isFetchingCostData ? (
              <div className="no-selection-message">
                <p>Please select a subscription, resource group(s), and click "Get Cost Data" to view analytics.</p>
              </div>
            ) : isFetchingCostData ? (
              <div className="loading-cost-data">
                <ApexLoader size={56} />
                <p>Loading cost data...</p>
              </div>
            ) : (
          <>
            <div className="cost-overview">
              <div className="cost-card">
                <div className="card-header">
                  <h3>Total Spend</h3>
                  <div className="info-icon" onClick={() => setOpenInfoModal('total-spend')}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                      <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
                    </svg>
                  </div>
                </div>
                <div className="cost-value">{formatCurrency(costData?.totalCost || 0)}</div>
                <div className={`cost-change ${(costData?.percentChange || 0) >= 0 ? 'positive' : 'negative'}`}>
                  {formatPercentChange(costData?.percentChange || 0)} from last period
                </div>
              </div>
              <div className="cost-card">
                <div className="card-header">
                  <h3>Daily Average</h3>
                  <div className="info-icon" onClick={() => setOpenInfoModal('daily-average')}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                      <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
                    </svg>
                  </div>
                </div>
                <div className="cost-value">{formatCurrency(costData?.dailyAverage || 0)}</div>
                <div className="cost-change">Over {timePeriod === '7d' ? '7' : timePeriod === '30d' ? '30' : '90'} days</div>
              </div>
              <div className="cost-card">
                <div className="card-header">
                  <h3>Projected Monthly</h3>
                  <div className="info-icon" onClick={() => setOpenInfoModal('projected-monthly')}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                      <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
                    </svg>
                  </div>
                </div>
                <div className="cost-value">{formatCurrency(costData?.projectedMonthly || 0)}</div>
                <div className="cost-change">Based on current usage</div>
              </div>
            </div>

            <div className="cost-charts">
              <div className="chart-container">
                <div className="section-header">
                  <h3>Cost Trend</h3>
                  <div className="info-icon" onClick={() => setOpenInfoModal('cost-trend')}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                      <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
                    </svg>
                  </div>
                </div>
                {costData && costData.costByDay.length > 0 ? (
                  <>
                    <div className="trend-summary">
                      <div className="trend-stat">
                        <span className="trend-label">Peak Day</span>
                        <span className="trend-value">
                          {formatCurrency(Math.max(...costData.costByDay.map(d => d.cost)))}
                        </span>
                      </div>
                      <div className="trend-stat">
                        <span className="trend-label">Lowest Day</span>
                        <span className="trend-value">
                          {formatCurrency(Math.min(...costData.costByDay.map(d => d.cost)))}
                        </span>
                      </div>
                      <div className="trend-stat">
                        <span className="trend-label">Trend Direction</span>
                        {renderTrend(costData.percentChange, 'trend-value')}
                      </div>
                    </div>
                    <div className="cost-chart">
                      <div className="chart-y-axis">
                        {(() => {
                          const aggregatedData = aggregateCostData(costData.costByDay, timePeriod);
                          const maxCost = Math.max(...aggregatedData.map(d => d.cost));
                          const steps = 5;
                          const stepValue = maxCost / steps;
                          return Array.from({ length: steps + 1 }, (_, i) => (
                            <div key={i} className="y-axis-label">
                              <span>{formatCurrency(stepValue * (steps - i))}</span>
                            </div>
                          ));
                        })()}
                      </div>
                      <div className="chart-content">
                        <div className="chart-grid">
                          {Array.from({ length: 6 }, (_, i) => (
                            <div key={i} className="grid-line" />
                          ))}
                        </div>
                        <div className="chart-bars">
                          {aggregateCostData(costData.costByDay, timePeriod).map((day, index) => {
                            const aggregatedData = aggregateCostData(costData.costByDay, timePeriod);
                            const maxCost = Math.max(...aggregatedData.map(d => d.cost));
                            const heightPercent = maxCost > 0 ? (day.cost / maxCost) * 100 : 0;
                            
                            // Parse date - handle both YYYY-MM-DD and YYYYMMDD formats
                            let formattedDate = '';
                            try {
                              let dateStr = day.date.toString();
                              let year, month, dayNum;
                              
                              if (dateStr.includes('-')) {
                                // Format: YYYY-MM-DD
                                const dateParts = dateStr.split('-');
                                year = parseInt(dateParts[0]);
                                month = parseInt(dateParts[1]) - 1;
                                dayNum = parseInt(dateParts[2]);
                              } else if (dateStr.length === 8) {
                                // Format: YYYYMMDD
                                year = parseInt(dateStr.substring(0, 4));
                                month = parseInt(dateStr.substring(4, 6)) - 1;
                                dayNum = parseInt(dateStr.substring(6, 8));
                              } else {
                                formattedDate = dateStr;
                                throw new Error('Unknown format');
                              }
                              
                              const dateObj = new Date(year, month, dayNum);
                              formattedDate = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                            } catch (e) {
                              console.error('Date parsing error:', e, 'for date:', day.date);
                              formattedDate = day.date.toString();
                            }
                            
                            return (
                              <div key={index} className="chart-bar-wrapper">
                                <div 
                                  className="chart-bar" 
                                  style={{ height: `${heightPercent}%` }}
                                  title={`${formattedDate}: ${formatCurrency(day.cost)}`}
                                >
                                  <span className="bar-value">{formatCurrency(day.cost)}</span>
                                </div>
                                <span className="bar-label">{formattedDate}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="chart-placeholder">
                    <p>No cost trend data available</p>
                  </div>
                )}
              </div>
              <div className="chart-container">
                <div className="section-header">
                  <h3>Cost by Resource Group</h3>
                  <div className="info-icon" onClick={() => setOpenInfoModal('cost-by-rg')}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                      <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
                    </svg>
                  </div>
                </div>
                <div className="rg-breakdown">
                  {costData && costData.costByResourceGroup.length > 0 ? (
                    <table className="rg-breakdown-table">
                      <thead>
                        <tr>
                          <th>Resource Group</th>
                          <th>Total Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {costData.costByResourceGroup
                          .sort((a, b) => b.cost - a.cost)
                          .map((rg, index) => (
                            <tr key={index}>
                              <td>{rg.name}</td>
                              <td className="total-cost">{formatCurrency(rg.cost)}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  ) : (
                    <p>No resource group data available</p>
                  )}
                </div>
              </div>
            </div>

            <div className="cost-details">
              <div className="section-header">
                <h3>Cost Details</h3>
                <div className="info-icon" onClick={() => setOpenInfoModal('cost-details')}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                    <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
                  </svg>
                </div>
              </div>
              
              {costData && costData.costDetails.some(d => d.service.toLowerCase().includes('operationalinsights')) && (
                <div className="cost-info-banner">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="banner-icon">
                    <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                    <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
                  </svg>
                  <div className="banner-content">
                    <strong>Workspace-Based Services:</strong> Log Analytics workspace costs include charges from connected services like Application Insights, Container Insights, and VM Insights. These services store their data in the workspace and are billed under the workspace resource.
                  </div>
                </div>
              )}
              
              <div className="cost-table">
                <table>
                  <thead>
                    <tr>
                      <th>Resource Group</th>
                      <th>Service</th>
                      <th>Resource</th>
                      <th>Daily Cost</th>
                      <th>Total Cost</th>
                      <th>Trend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costData && costData.costDetails.length > 0 ? (
                      costData.costDetails.map((detail, index) => (
                        <tr key={index}>
                          <td>{detail.resourceGroup}</td>
                          <td>{detail.service}</td>
                          <td>{detail.resource}</td>
                          <td>{formatCurrency(detail.dailyCost)}</td>
                          <td className="total-cost">{formatCurrency(detail.totalCost)}</td>
                          <td className="trend">
                            {renderTrend(detail.trend)}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={6} className="no-data">
                          No billable resources found with costs in the selected time period.
                          Resources with $0.00 spend are not displayed.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            </>
            )}
          </>
        )}
      </div>
    </div>
  );
};
