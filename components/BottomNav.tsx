import React from 'react';
import { Phone, Users, User, Radio } from 'lucide-react';

interface Props {
  currentPage: string;
  onNavigate: (page: string) => void;
}

const BottomNav: React.FC<Props> = ({ currentPage, onNavigate }) => {
  const navItems = [
    { id: 'calls', icon: Phone, label: 'Calls' },
    { id: 'contacts', icon: Users, label: 'Contacts' },
    { id: 'ptt', icon: Radio, label: 'Walkie' },
    { id: 'profile', icon: User, label: 'Profile' },
  ];

  return (
    <div className="fixed bottom-0 left-0 w-full bg-secondary border-t border-gray-700 pb-safe">
      <div className="flex justify-around items-center h-16">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={`flex flex-col items-center justify-center w-full h-full space-y-1 ${
              currentPage === item.id ? 'text-primary' : 'text-gray-400'
            }`}
          >
            <item.icon size={24} />
            <span className="text-xs font-medium">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default BottomNav;